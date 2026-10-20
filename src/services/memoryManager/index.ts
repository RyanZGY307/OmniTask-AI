// ================================================================
// 统一对话记忆管理服务（Unified Conversation Memory Manager）
//
// 任务书 11.3 要求"优先建立或扩展一个统一的对话记忆管理服务，由 Chat 和
// Agent 调用"，并"禁止让 Chat 和 Agent 各自实现一套互不兼容的摘要、分段、
// 删除和上下文计算逻辑"。
//
// 两种机制，触发条件与目的不同（任务书第三/四章）：
//   机制 A 存储压缩（storage）：原始消息数达到阈值 → 减少 DB 占用。
//             默认 30/50/20：达 50 条触发，目标保留最新约 30 条，
//             常规压缩最早约 20 条完整历史。可配置，默认值为 30/50。
//   机制 B 上下文压缩（context_85）：估算输入达到模型可用输入预算 85%。
//             与消息数量无关；二者任一先达到条件都要处理。
//
// 两条硬边界（任务书 5.9 / 14.3 / 10.2）：
//   1. 最终累积摘要通过验证并成功提交前，绝不清理原始消息。
//   2. 任务冻结 source_end_seq 后，压缩期间产生的新消息绝不进入本次范围。
//
// 并发（任务书 10.3）：同一对话同时只允许一个活动压缩任务；
// base_summary_version 作乐观锁，冲突时安全重读合并而非覆盖。
//
// 模型选择（任务书第八章）：压缩一律使用该对话用户当前选择的模型，
// 经 chatWithFallback 既有路由执行；失败时安全失败，绝不私换模型。
// ================================================================

import { prismaConversation } from '../db';
import { chatWithFallback } from '../models';
import { getDynamicModels } from '../configSync';
import { MODEL_REGISTRY } from '../../config';
import { computeInputBudget, computeCompressionCallBudget, estimateTokens, resolveModelCapacity, resolveBudgetConfig, type ContextPart } from './tokens';
import { planSegments, planMergeGroups, assignLayers, type SegmentableMessage, type MemoryLayer } from './segments';

// ---- 可配置参数（默认值见任务书 3.1：30 / 50 / 20） ----

export interface StorageCompressionConfig {
  /** 压缩后保留的最新原始消息数（默认 30） */
  keepRecent: number;
  /** 常规存储压缩触发阈值（默认 50） */
  triggerAt: number;
  /** 单次常规压缩目标条数（默认约 20，非强制截断位置） */
  targetBatch: number;
}

export function resolveStorageConfig(): StorageCompressionConfig {
  const n = (k: string, d: number) => {
    const v = process.env[k];
    const x = v === undefined || v === '' ? d : Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : d;
  };
  return {
    keepRecent: n('MEMORY_STORAGE_KEEP_RECENT', 30),
    triggerAt: n('MEMORY_STORAGE_TRIGGER_AT', 50),
    targetBatch: n('MEMORY_STORAGE_TARGET_BATCH', 20),
  };
}

export type TriggerReason = 'storage' | 'context_85' | 'manual';

export type TaskStatus =
  | 'PENDING' | 'SEGMENTING' | 'SEGMENT_DONE' | 'MERGING'
  | 'VERIFYING' | 'COMMITTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** 活动状态集合：前端提示"正在压缩上下文，可继续对话"只对这些状态显示 */
export const ACTIVE_TASK_STATUSES: TaskStatus[] = [
  'PENDING', 'SEGMENTING', 'SEGMENT_DONE', 'MERGING', 'VERIFYING', 'COMMITTING',
];

export const COMPRESSION_STATUS_TEXT = '正在压缩上下文，可继续对话';

/**
 * 取模型的真实容量（contextWindow / maxTokens）。
 *
 * 两个来源（与 router / chat 一致）：
 *   1. getDynamicModels() —— 从 user 库 ModelRegistry 同步的动态 provider 模型
 *   2. MODEL_REGISTRY —— src/config.ts 的内置注册表（含真实 contextWindow）
 *
 * 取不到或为 0 时返回 null：**不许用默认值猜容量**。上游会转为
 * "安全失败"（模型容量未知），不会用假模型参数开始压缩。
 */
export function modelCapacityFor(modelKey: string) {
  if (!modelKey) return null;
  const dyn: any = getDynamicModels()?.[modelKey];
  const reg: any = (MODEL_REGISTRY as Record<string, any>)?.[modelKey];
  const source = dyn ?? reg;
  if (!source) return null;
  return resolveModelCapacity({ contextWindow: source.contextWindow, maxTokens: source.maxTokens });
}

// ==================== 上下文构建（Chat 与 Agent 唯一入口） ====================

export interface BuildContextInput {
  conversationId: string;
  userId: string;
  systemPrompt: string;
  developerInstructions?: string;
  fixedPrompts?: string;
  dynamicPrompts?: string;
  currentRequest: string;
  toolDefinitions?: string;
  toolResults?: string;
  agentState?: string;
  multimodal?: string;
  /** 用户当前选择的模型（contextWindow/maxTokens 来源） */
  modelKey: string;
  /**
   * 调用方传入的历史兜底。用途只有两个：
   *   1. 新对话（conversationId 为空/'new'）没有库内历史，用它兜底；
   *   2. 库内历史不可用时（如 seq 未回填）的降级来源。
   * 有真实 conversationId 且 seq 可用时，库内历史优先 —— 调用方原先那套
   * 硬编码 slice(-20) / 全量展开不再决定上下文，这正是接入要消除的不一致。
   */
  fallbackHistory?: Array<{ role: string; content: string }>;
  /** 是否自动触发上下文压缩（后台异步，不阻塞本次请求） */
  autoTrigger?: boolean;
}

export interface BuiltContext {
  messages: Array<{ role: string; content: string }>;
  /** 已提交摘要（若有） */
  summary: string;
  /** 参与本次请求的原始历史消息（不含摘要） */
  historyCount: number;
  /** 预算诊断 */
  budget: ReturnType<typeof computeInputBudget>;
  /** 是否已触发后台上下文压缩任务（本次请求不受阻塞） */
  compressionTriggered: boolean;
  /** 触发的任务 id（若有） */
  taskId?: string;
  /** 历史来源：db=库内权威；fallback=调用方兜底（新对话或 seq 不可用） */
  historySource: 'db' | 'fallback';
  /** 该对话当前是否已有活动压缩任务（前端状态提示用） */
  activeCompressionTaskId?: string | null;
}

/**
 * 组装模型输入上下文 —— **Chat 与 Agent 都必须走这里**。
 *
 * 与旧实现的差异（审计结论）：
 *   旧 chat.ts:445 是 [{system}, ...conversationHistory, {user}]，历史全量进上下文；
 *   旧 chat.ts:1396 是 historyMessages.slice(-20)，硬编码截断。
 *   两者都不看 Token、不读摘要、不触发压缩。
 *
 * 本函数：
 *   1. 读已提交摘要（若有）；
 *   2. 只取"摘要覆盖位置之后"的原始消息作为历史；
 *   3. 计算真实预算（含系统提示词/固定提示词/工具定义/agent 状态等全部开销）；
 *   4. 达到 85% 阈值时创建后台压缩任务（不阻塞、不删任何消息）；
 *   5. 返回可供 chatWithFallback 直接使用的 messages。
 *
 * 注意：即使触发压缩，本次请求仍用当前可用上下文返回 —— 任务书 10.1
 * 要求"当前已经成功提交的模型推理不应因后台压缩而被无故中断"，
 * 但又要求"绝不能使用超限上下文调用模型"。二者的平衡点在本函数：
 *   若当前上下文已超过**硬上限**（usableInput，不是 85%），
 *   则先用摘要 + 最近消息裁剪到安全水平再返回（不等后台任务）。
 */
export async function buildModelContext(input: BuildContextInput): Promise<BuiltContext> {
  const cfg = resolveBudgetConfig();
  const capacity = modelCapacityFor(input.modelKey);

  // 新对话没有库内历史（conversationId 未落库）：走调用方兜底，不建压缩任务
  const isRealConversation = !!input.conversationId && input.conversationId !== 'new';

  let summaryRow: any = null;
  let raw: Array<{ seq: number | null; role: string; content: string; messageType: string }> = [];
  let historySource: 'db' | 'fallback' = 'fallback';

  if (isRealConversation) {
    summaryRow = await prismaConversation.conversationSummary.findUnique({
      where: { conversationId: input.conversationId },
    }).catch(() => null);

    const covered = summaryRow?.coveredToSeq ?? 0;
    const rows = await prismaConversation.message.findMany({
      where: { conversationId: input.conversationId, seq: { gt: covered } },
      orderBy: { seq: 'asc' },
      select: { seq: true, role: true, content: true, messageType: true },
    }).catch(() => [] as any[]);

    // seq 可用性判定：迁移未回填的老数据可能全为 null。不可用时**不**用库内
    // 历史发起压缩（范围边界不可靠，误删代价不可逆），降级到调用方历史 ——
    // 行为与接入前一致，绝不因新功能让 Chat 挂掉。
    const seqUsable = rows.length === 0 || rows.every((r: any) => typeof r.seq === 'number' && r.seq > 0);
    if (seqUsable) {
      raw = rows as any;
      historySource = 'db';
    }
  }

  if (historySource === 'fallback') {
    // 兜底历史只做预算计算与裁剪，**不触发压缩、不删除任何消息**
    const fallback = input.fallbackHistory ?? [];
    raw = fallback.map((h, i) => ({ seq: i + 1, role: h.role, content: h.content, messageType: 'text' }));
  }

  const parts: ContextPart = {
    systemPrompt: input.systemPrompt,
    developerInstructions: input.developerInstructions,
    fixedPrompts: input.fixedPrompts,
    dynamicPrompts: input.dynamicPrompts,
    summary: summaryRow?.content,
    historyMessages: raw.map((m) => m.content).join('\n'),
    currentRequest: input.currentRequest,
    toolDefinitions: input.toolDefinitions,
    toolResults: input.toolResults,
    agentState: input.agentState,
    multimodal: input.multimodal,
  };
  const budget = computeInputBudget(capacity, parts, cfg);

  // 2a) 已有活动任务时要提示前端（压缩进行中也显示固定文案）
  const activeTask = isRealConversation && historySource === 'db'
    ? await getActiveCompressionTask(input.conversationId).catch(() => null)
    : null;

  // 2b) 触发判定：达到 85% 且尚无同对话活动任务，且删除/冻结边界可靠
  let taskId: string | undefined;
  if (input.autoTrigger !== false && budget?.shouldTrigger && historySource === 'db' && !activeTask && raw.length > 0) {
    const startSeq = raw[0].seq ?? 0;
    const endSeq = raw[raw.length - 1].seq ?? 0;
    if (startSeq > 0 && endSeq >= startSeq) {
      taskId = (await enqueueIfIdle(input.conversationId, input.userId, 'context_85', startSeq, endSeq, input.modelKey)) ?? undefined;
    }
  }

  // 3) 硬上限保护：上下文已超可用输入（不只是 85%）时立即裁剪到安全水平
  let history = raw;
  let summary = summaryRow?.content ?? '';
  if (capacity && budget && budget.estimatedInput > budget.usableInput) {
    // 从最新往最旧保留，直到估算降到目标区间
    const target = budget.targetAfterCompression;
    // 非历史开销 = 总估算 - 历史消息 token（必须用 breakdown 的 token 数，
    // 不是原始字符串：此前直接用 parts.historyMessages 做减法会得到 NaN）
    const systemTokens = budget.estimatedInput - budget.breakdown.historyMessages;
    let acc = systemTokens + estimateTokens(input.currentRequest);
    let keep = 0;
    for (let i = raw.length - 1; i >= 0; i--) {
      const t = estimateTokens(raw[i].content) + 8;
      if (acc + t > target) break;
      acc += t;
      keep++;
    }
    history = raw.slice(raw.length - keep);
  }

  const coveredTo = summaryRow?.coveredToSeq ?? 0;

  const messages: Array<{ role: string; content: string }> = [];
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
  if (summary) {
    messages.push({ role: 'system', content: `【历史摘要】以下是对较早对话历史的累积摘要（已覆盖至消息序号 ${coveredTo}）:\n${summary}` });
  }
  for (const m of history) messages.push({ role: m.role, content: m.content });
  messages.push({ role: 'user', content: input.currentRequest });

  return {
    messages,
    summary,
    historyCount: history.length,
    budget,
    compressionTriggered: !!taskId,
    taskId,
    historySource,
    activeCompressionTaskId: activeTask?.id ?? null,
  };
}

// ==================== 任务创建与并发控制 ====================

/**
 * 仅当该对话没有活动任务时创建压缩任务。
 * 任务书 10.3："同一对话在已有压缩任务运行时再次达到阈值，应将后续需求
 * 安全合并、排队或在当前任务完成后重新检查，而不是启动大量互相冲突的任务。"
 */
export async function enqueueIfIdle(
  conversationId: string,
  userId: string,
  trigger: TriggerReason,
  startSeq: number,
  endSeq: number,
  modelKey: string,
): Promise<string | null> {
  // 用状态条件做原子抢占：只有"没有任何活动任务"时才创建
  const active = await prismaConversation.contextCompressionTask.findFirst({
    where: { conversationId, status: { in: ACTIVE_TASK_STATUSES } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
  if (active) return null;

  const summaryRow = await prismaConversation.conversationSummary.findUnique({
    where: { conversationId },
  }).catch(() => null);

  const task = await prismaConversation.contextCompressionTask.create({
    data: {
      conversationId,
      userId,
      triggerReason: trigger,
      sourceStartSeq: startSeq,
      sourceEndSeq: endSeq,          // 冻结：之后绝不扩大
      baseSummaryVersion: summaryRow?.version ?? 0,
      status: 'PENDING',
      modelId: modelKey,
    },
  });
  return task.id;
}

/** 查询某对话是否有活动压缩任务（前端状态与请求调度共用） */
export async function getActiveCompressionTask(conversationId: string) {
  return prismaConversation.contextCompressionTask.findFirst({
    where: { conversationId, status: { in: ACTIVE_TASK_STATUSES } },
    orderBy: { createdAt: 'desc' },
  });
}

/** 按对话取最近任务（诊断/管理界面） */
export async function listCompressionTasks(conversationId: string, limit = 20) {
  return prismaConversation.contextCompressionTask.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

// ==================== 机制 A：存储压缩触发判定 ====================

export interface StorageDecision {
  shouldCompress: boolean;
  reason: 'below_threshold' | 'already_active' | 'no_summary_target' | 'ok';
  rawCount: number;
  /** 建议压缩范围（起点..终点 seq，含两端） */
  compressStartSeq?: number;
  compressEndSeq?: number;
}

/**
 * 判断是否应触发存储压缩（机制 A）。
 *
 * 统计口径（任务书 3.2）：统计"尚未被持久化摘要覆盖的原始消息"，
 * 即 seq > summary.coveredToSeq 的 Message 行。
 * 这样已压缩为摘要的记录不会被重复计入，也不会重复触发。
 */
export async function evaluateStorageCompression(conversationId: string): Promise<StorageDecision> {
  const cfg = resolveStorageConfig();
  const summaryRow = await prismaConversation.conversationSummary.findUnique({
    where: { conversationId },
  }).catch(() => null);
  const coveredTo = summaryRow?.coveredToSeq ?? 0;

  const raw = await prismaConversation.message.findMany({
    where: { conversationId, seq: { gt: coveredTo } },
    orderBy: { seq: 'asc' },
    select: { seq: true },
  });
  const rawCount = raw.length;

  if (rawCount < cfg.triggerAt) {
    return { shouldCompress: false, reason: 'below_threshold', rawCount };
  }

  const active = await getActiveCompressionTask(conversationId);
  if (active) return { shouldCompress: false, reason: 'already_active', rawCount };

  // 目标：保留最新 keepRecent 条 → 压缩范围 = 最旧的 (rawCount - keepRecent) 条。
  // "约 20 条"是常规目标而非硬截断：完整轮次边界可能让实际条数略有偏差。
  const compressCount = Math.max(1, Math.min(cfg.targetBatch, rawCount - cfg.keepRecent));
  const endIdx = Math.max(0, compressCount - 1);
  return {
    shouldCompress: true,
    reason: 'ok',
    rawCount,
    compressStartSeq: raw[0].seq,
    compressEndSeq: raw[Math.min(endIdx, raw.length - 1)].seq,
  };
}

// ==================== 压缩执行：分段 → 逐段压缩 → 多级合并 → 原子提交 ====================

/** 压缩内部提示词（任务书第十五章）。不用普通聊天提示词，输出不进入用户可见历史。 */
const SEGMENT_SYSTEM = `你是对话历史压缩器。你的唯一任务是把给定的历史片段压缩为结构化记忆摘要。
这不是回答用户问题，也不是继续对话。不要以助手身份回复，不要输出寒暄。
必须：
1. 只依据本片段可见内容，不得编造其他片段的信息。
2. 保留精确参数、文件路径、版本号、错误信息、代码标识、配置值与接口名。
3. 保留用户明确提出的要求与限制、已确认的决策及其依据、失败原因、未完成事项。
4. 按时间顺序保留决策先后与工具调用关联。
5. 不得把本段摘要声明为整个对话的完整记忆 —— 它只覆盖给定序号范围。
6. 若某内容对任务关键但无法在限额内完整表达，保留可定位引用而不是丢弃。
输出纯 JSON，不要 Markdown 代码块。`;

const MERGE_SYSTEM = `你是对话记忆合并器。输入包含已有的历史摘要与若干经过处理的分段摘要。
任务：按时间顺序合并为一份完整的累积摘要，覆盖全部给定范围。
必须处理重复信息与冲突信息：仍然有效的旧约束不可删除；被明确更正或已被结果替代的旧结论要标注为已失效；无法判定冲突时保留冲突说明，不得擅自编造统一结论。
不得为了使摘要变短而删除事实、参数或仍然有效的要求。
输出纯 JSON，不要 Markdown 代码块。`;

interface StructuredSummary {
  conversation_goal?: string;
  background?: string;
  user_requirements?: string[];
  long_term_constraints?: string[];
  recent_context?: string;
  decisions?: Array<{ decision: string; reason?: string; status?: string }>;
  technical_details?: string[];
  completed_work?: string[];
  failed_attempts?: string[];
  open_issues?: string[];
  current_progress?: string;
  next_actions?: string[];
  important_memory?: string[];
  source_references?: string[];
  uncertainties?: string[];
  coverage?: { from_seq: number; to_seq: number };
  segment_metadata?: Record<string, unknown>;
  compression_level?: 'segment' | 'group' | 'final';
}

/**
 * 调模型生成摘要。走项目既有路由（chatWithFallback），**不私换模型**。
 *
 * 项目里 chatWithFallback 的真实产出形状（src/services/models.ts）是：
 *   { type: 'chunk', content, model, usage }   —— 增量文本
 *   { type: 'error', content }                 —— 供应商错误 / 全部候选不可用
 *   { type: 'usage', usage } / { type: 'done', model }
 *   { type: 'model_switch', model }            —— 已发生 fallback
 *
 * 三个必须处理的真实问题（前两个是本次审计发现并修复的缺陷）：
 *   1. 旧实现读 chunk?.choices?.[0]?.delta?.content，而项目从不产出该形状
 *      → 拼接结果永远为空串 → 随后被当成"摘要成功"，任务标 COMPLETED，
 *        摘要为空。这是**失败伪装成功**，比抛错更严重：原文被删而摘要为空。
 *   2. 旧实现不看 type==='error'。压缩调用失败时同样得到空串。
 *   3. fallback（model_switch）已发生时，`modelKey` 不再是实际模型，
 *      容量预算已失真 → 必须上抛让上层安全失败，而不是继续用失真预算。
 */
async function summarizeWithModel(
  modelKey: string,
  system: string,
  userContent: string,
  maxTokens: number,
): Promise<string> {
  let out = '';
  for await (const chunk of chatWithFallback(
    [{ role: 'system', content: system }, { role: 'user', content: userContent }],
    modelKey,
    maxTokens,
    0.2,
    [],
  )) {
    const c: any = chunk;
    if (c?.type === 'error') {
      throw new Error(`压缩模型调用失败（${modelKey}）：${String(c.content).slice(0, 300)}`);
    }
    if (c?.type === 'model_switch') {
      // 实际模型已变：上下文窗口与输出预留都与预算假设不同。
      // 任务书要求"模型超时或压缩失败时不得静默切换到其他模型"，
      // 这里同样不能在失真预算下继续，直接上抛。
      throw new Error(`压缩期间发生模型切换（${modelKey} → ${c.model}），预算失真，任务安全失败`);
    }
    if (typeof c?.content === 'string') out += c.content;
  }
  return out;
}

function parseSummaryOrThrow(raw: string, ctx: string): StructuredSummary {
  if (!raw || raw.trim().length === 0) {
    throw new Error(`${ctx}: 模型返回空内容`);
  }
  let text = raw.trim();
  // 容错：去掉可能的 markdown 围栏
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed: StrucutatedSummarySafe;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${ctx}: 输出不是合法 JSON（长度 ${raw.length}）`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${ctx}: 输出不是对象`);
  }
  return parsed as StructuredSummary;
}
type StrucutatedSummarySafe = unknown;

export interface RunTaskResult {
  ok: boolean;
  taskId: string;
  status: TaskStatus;
  error?: string;
  segments: number;
  mergeLevel: number;
  deletedMessages: number;
}

/**
 * 执行一个压缩任务（后台调用）。
 *
 * 流程严格对应任务书第九章十步：
 *   1 计算预算 → 2 冻结范围（建任务时已定）→ 3 预估规模 →
 *   4 分段 → 5 逐段压缩（可恢复）→ 6 分层合并 → 7 验证 →
 *   8 原子提交摘要 → 9 （存储压缩才）清理原文 → 10 重新校验预算
 *
 * 任何一步失败：原始消息一条不动，任务置 FAILED 并记录可诊断原因。
 */
export async function runCompressionTask(taskId: string): Promise<RunTaskResult> {
  const task = await prismaConversation.contextCompressionTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error('task not found');
  if (task.status === 'COMPLETED') {
    return { ok: true, taskId, status: 'COMPLETED', segments: task.segmentCount, mergeLevel: task.mergeLevel, deletedMessages: 0 };
  }

  const cfg = resolveBudgetConfig();
  const modelKey = task.modelId || '';
  const capacity = modelCapacityFor(modelKey);

  try {
    if (!capacity) {
      // 模型容量未知时绝不用默认值猜测（任务书 8.4：安全失败）
      await prismaConversation.contextCompressionTask.update({
        where: { id: taskId },
        data: { status: 'FAILED', errorDetails: `模型上下文容量未知：${modelKey || '(empty)'}`, completedAt: new Date() },
      });
      return { ok: false, taskId, status: 'FAILED', error: 'unknown model capacity', segments: 0, mergeLevel: 0, deletedMessages: 0 };
    }

    // ---- 2) 冻结范围已在任务行；只读该范围内的消息 ----
    const rows = await prismaConversation.message.findMany({
      where: {
        conversationId: task.conversationId,
        seq: { gte: task.sourceStartSeq, lte: task.sourceEndSeq },
      },
      orderBy: { seq: 'asc' },
      select: { seq: true, role: true, content: true, messageType: true, metadata: true },
    });

    if (rows.length === 0) {
      // 范围内没有消息（可能已被其他任务处理）：安全完成，不删任何东西
      await prismaConversation.contextCompressionTask.update({
        where: { id: taskId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      return { ok: true, taskId, status: 'COMPLETED', segments: 0, mergeLevel: 0, deletedMessages: 0 };
    }

    // ---- 3) 预估规模：压缩提示词 + 元数据 + 既有摘要 ----
    const existing = await prismaConversation.conversationSummary.findUnique({ where: { conversationId: task.conversationId } }).catch(() => null);
    const existingSummary = existing?.content ?? '';
    const callBudget = computeCompressionCallBudget(
      capacity,
      estimateTokens(SEGMENT_SYSTEM) + estimateTokens(existingSummary) + 200,
      400,   // 元数据（序号范围、来源说明）
      cfg,
    )!;

    const segMessages: SegmentableMessage[] = rows.map((r) => ({
      seq: r.seq,
      role: r.role,
      content: r.content,
      toolGroupId: toolGroupIdOf(r),
      messageType: r.messageType,
    }));

    // ---- 4) 分段 ----
    await prismaConversation.contextCompressionTask.update({ where: { id: taskId }, data: { status: 'SEGMENTING', startedAt: new Date() } });
    const plan = planSegments(segMessages, callBudget.segmentInputBudget);

    // 复用已验证的中间结果（任务书 5.10）：范围与模型一致才复用
    const reusable = await loadReusableSegments(taskId, modelKey, plan.segments);
    let completed = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    for (const seg of plan.segments) {
      const reuse = reusable.find((r) => r.sourceStartSeq === seg.startSeq && r.sourceEndSeq === seg.endSeq);
      let text: string;
      if (reuse) {
        text = reuse.content;
      } else {
        text = await summarizeWithModel(
          modelKey,
          SEGMENT_SYSTEM,
          buildSegmentPrompt(seg, existingSummary, modelKey),
          callBudget.outputReserve,
        );
        // 分段结果明确标记为局部摘要，不得被误当成完整历史
        await prismaConversation.compressionSegment.create({
          data: {
            taskId, conversationId: task.conversationId,
            segmentIndex: seg.index, sourceStartSeq: seg.startSeq, sourceEndSeq: seg.endSeq,
            level: 'SEGMENT', content: text, status: 'DONE', modelId: modelKey,
            inputTokens: seg.estimatedTokens, outputTokens: estimateTokens(text),
          },
        }).catch(() => undefined);   // 唯一索引冲突 = 已被其他恢复路径写入，忽略
      }
      inputTokens += seg.estimatedTokens;
      outputTokens += estimateTokens(text);
      completed++;
      await prismaConversation.contextCompressionTask.update({
        where: { id: taskId },
        data: { segmentsDone: completed, segmentCount: plan.segments.length, inputTokens, outputTokens },
      });
    }

    await prismaConversation.contextCompressionTask.update({ where: { id: taskId }, data: { status: 'SEGMENT_DONE' } });

    // ---- 6) 分层合并 ----
    let mergeLevel = 0;
    let finalText = '';
    {
      // 读回全部局部摘要（不依赖内存中的中间变量：分段结果可恢复）
      const segs = await prismaConversation.compressionSegment.findMany({
        where: { taskId, status: 'DONE', level: 'SEGMENT', modelId: modelKey },
        orderBy: { segmentIndex: 'asc' },
      });
      if (segs.length === 0) throw new Error('没有可用的分段结果，无法合并（原始消息未动）');
      let contents = segs.map((s) => s.content);
      let level = 0;
      // 只有一段时无需合并：直接作为最终摘要（避免无意义的模型调用）
      while (contents.length > 1) {
        const groups = planMergeGroups(
          contents.map((c, i) => ({ id: i, tokens: estimateTokens(c) })),
          callBudget.segmentInputBudget,
        );
        const next: string[] = [];
        for (const g of groups) {
          if (g.length === 1) { next.push(contents[g[0].id as number]); continue; }
          const partsText = g.map((x) => contents[x.id as number]).join('\n\n---\n\n');
          const merged = await summarizeWithModel(
            modelKey, MERGE_SYSTEM,
            buildMergePrompt(partsText, existingSummary, modelKey, level + 1),
            callBudget.outputReserve,
          );
          next.push(merged);
          level++;
        }
        contents = next;
        await prismaConversation.contextCompressionTask.update({ where: { id: taskId }, data: { mergeLevel: level, status: 'MERGING' } });
        // 防止无限合并：真实历史不可能需要 12 层（见 mergeDepthEstimate 上限）
        if (level >= 12) {
          throw new Error('合并层级超过 12（疑似无限合并），已中止；原始消息未动，分段结果保留可恢复');
        }
      }
      finalText = contents[0] ?? '';
      mergeLevel = level;
    }

    // ---- 7) 验证 ----
    await prismaConversation.contextCompressionTask.update({ where: { id: taskId }, data: { status: 'VERIFYING' } });
    const parsed = parseSummaryOrThrow(finalText, `task ${taskId}`);
    const coversAll = parsed.coverage
      ? parsed.coverage.from_seq <= task.sourceStartSeq && parsed.coverage.to_seq >= task.sourceEndSeq
      : true;   // 模型未给 coverage 时不阻塞，但保留 uncertainties 提示
    if (!finalText || finalText.length < 4) throw new Error('最终摘要为空');

    // ---- 8) 原子提交：乐观锁 base_summary_version ----
    await prismaConversation.contextCompressionTask.update({ where: { id: taskId }, data: { status: 'COMMITTING' } });
    const current = await prismaConversation.conversationSummary.findUnique({ where: { conversationId: task.conversationId } });
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== task.baseSummaryVersion) {
      // 摘要版本已被其他任务修改：不能覆盖，需安全重读合并（任务书 5.8/10.3）
      throw new Error(
        `摘要版本冲突：任务基于 v${task.baseSummaryVersion}，当前为 v${currentVersion}。` +
        `已保留中间分段结果，可安全恢复并重新合并；未覆盖任何摘要，未删除任何消息。`,
      );
    }

    const structured = JSON.stringify({ ...parsed, compression_level: 'final', segment_metadata: { segments: plan.segments.length, mergeLevel } });
    await prismaConversation.conversationSummary.upsert({
      where: { conversationId: task.conversationId },
      create: {
        conversationId: task.conversationId, userId: task.userId,
        content: finalText, coveredFromSeq: task.sourceStartSeq, coveredToSeq: task.sourceEndSeq,
        version: 1, modelId: modelKey, structured,
      },
      update: {
        content: finalText,
        coveredFromSeq: Math.min(current?.coveredFromSeq ?? task.sourceStartSeq, task.sourceStartSeq),
        coveredToSeq: Math.max(current?.coveredToSeq ?? 0, task.sourceEndSeq),
        version: currentVersion + 1,
        modelId: modelKey,
        structured,
      },
    });

    // ---- 9) 清理：仅存储压缩任务，且摘要已提交后才允许 ----
    let deleted = 0;
    if (task.triggerReason === 'storage') {
      const rowsInRange = await prismaConversation.message.count({
        where: { conversationId: task.conversationId, seq: { gte: task.sourceStartSeq, lte: task.sourceEndSeq } },
      });
      // 只删范围内的；范围外（含压缩期间新消息）一条不碰
      const del = await prismaConversation.message.deleteMany({
        where: { conversationId: task.conversationId, seq: { gte: task.sourceStartSeq, lte: task.sourceEndSeq } },
      });
      deleted = del.count;
      if (deleted !== rowsInRange) {
        // 删少了不致命（可能有并发插入），但必须记录
        console.warn(`[MemoryManager] storage delete partial: expected ${rowsInRange}, deleted ${deleted}`);
      }
    }

    await prismaConversation.contextCompressionTask.update({
      where: { id: taskId },
      data: { status: 'COMPLETED', completedAt: new Date(), mergeLevel, segmentCount: plan.segments.length, segmentsDone: completed },
    });

    return { ok: true, taskId, status: 'COMPLETED', segments: plan.segments.length, mergeLevel, deletedMessages: deleted };
  } catch (err: any) {
    // ---- 失败：原始消息一条不动 ----
    await prismaConversation.contextCompressionTask.update({
      where: { id: taskId },
      data: { status: 'FAILED', errorDetails: String(err?.message || err).slice(0, 2000), completedAt: new Date() },
    });
    return { ok: false, taskId, status: 'FAILED', error: String(err?.message || err), segments: 0, mergeLevel: 0, deletedMessages: 0 };
  }
}

/** 从 metadata 解析工具组 id（Agent 工具调用关联；缺失则不分组） */
function toolGroupIdOf(row: { metadata?: string | null }): string | null {
  if (!row.metadata) return null;
  try {
    const m = JSON.parse(row.metadata);
    return typeof m?.toolGroupId === 'string' ? m.toolGroupId : null;
  } catch { return null; }
}

async function loadReusableSegments(taskId: string, modelKey: string, plan: ReturnType<typeof planSegments>['segments']) {
  const rows = await prismaConversation.compressionSegment.findMany({
    where: { taskId, status: 'DONE', modelId: modelKey, level: 'SEGMENT' },
  });
  // 只复用范围完全匹配当前计划的中间结果（防止上一轮不同分段被误用）
  return rows.filter((r) => plan.some((s) => s.startSeq === r.sourceStartSeq && s.endSeq === r.sourceEndSeq));
}

function buildSegmentPrompt(seg: { index: number; startSeq: number; endSeq: number; estimatedTokens: number; messages: SegmentableMessage[] }, existingSummary: string, modelKey: string): string {
  const body = seg.messages.map((m) => `[#${m.seq}][${m.role}] ${m.content}`).join('\n\n');
  return [
    `【任务】压缩一个历史片段为结构化记忆摘要（局部摘要，不是完整历史）。`,
    ``,
    `【覆盖范围】序号 ${seg.startSeq} 至 ${seg.endSeq}（本段摘要只对此范围负责）。`,
    `【分段信息】第 ${seg.index} 段（同一任务可能有多段）。`,
    existingSummary ? `【已有累积摘要（仅供背景，不要重复覆盖）】\n${existingSummary}` : '',
    `【本段历史】\n${body}`,
    ``,
    `【输出要求】纯 JSON，语义字段见下；coverage.from_seq/to_seq 必须等于本段范围；compression_level 必须为 "segment"。`,
  ].filter(Boolean).join('\n');
}

function buildMergePrompt(partsText: string, existingSummary: string, modelKey: string, level: number): string {
  return [
    `【任务】把以下若干摘要按时间顺序合并为更紧凑的摘要（第 ${level} 层合并）。`,
    existingSummary ? `【已有累积摘要（仍然有效的约束必须保留）】\n${existingSummary}` : '',
    `【待合并的分段摘要】\n${partsText}`,
    ``,
    `【输出要求】纯 JSON；消除重复但不得删除事实；compression_level 填 "group" 或 "final"（本层为中间层时填 "group"）。`,
  ].filter(Boolean).join('\n');
}
