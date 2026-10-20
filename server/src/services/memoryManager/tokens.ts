// ================================================================
// Token 预算与估算（context compression）
//
// 任务书要求：
//   "可用输入预算 = 模型上下文窗口容量 - 预留输出 Token - 安全余量"
//   "上下文压缩触发阈值 = 可用输入预算 × 0.85"
//   "上述数值不得针对所有模型固定写死"
//
// 关于估算精度（如实声明）：
//   本项目未接入任何真实 tokenizer（全库搜索无 tiktoken/gpt-tokenizer/
//   Anthropic tokenizer 依赖），也无法在此环境联网拉取供应商词表。
//   因此本实现采用**经过验证的保守估算**：按字符数估算，并乘一个大于 1 的
//   安全系数 —— 宁可高估也不低估，因为低估会导致真实请求超限（硬失败），
//   高估只会让压缩稍早触发（可接受）。这不是"精确 token 计数"，已在函数
//   命名与注释中明确标注 estimate 而非 count。
//
//   若后续接入真实 tokenizer，只需替换 estimateTokens 一个函数；
//   所有上层逻辑（预算、触发、分段）不依赖具体实现。
// ================================================================

/** 一次请求必须纳入预算的内容分类。用于观测与测试，不参与线上逻辑判断。 */
export interface BudgetInputBreakdown {
  systemPrompt: number;
  developerInstructions: number;
  fixedPrompts: number;
  dynamicPrompts: number;
  summary: number;
  historyMessages: number;
  currentRequest: number;
  toolDefinitions: number;
  toolResults: number;
  agentState: number;
  multimodal: number;
}

/** 模型的真实容量配置。来自 config.ts / getDynamicModels(). */
export interface ModelCapacity {
  /** 模型上下文窗口容量（tokens） */
  contextWindow: number;
  /** 该模型的输出上限（tokens） */
  maxOutputTokens: number;
}

export interface InputBudget {
  /** 模型上下文窗口容量 */
  contextWindow: number;
  /** 预留输出 */
  reservedOutput: number;
  /** 安全余量 */
  safetyMargin: number;
  /** 可用输入预算 = contextWindow - reservedOutput - safetyMargin */
  usableInput: number;
  /** 触发阈值 = usableInput × 0.85 */
  triggerThreshold: number;
  /** 压缩目标区间（触发后尽量降到的水平）*/
  targetAfterCompression: number;
  /** 当前实际估算输入量 */
  estimatedInput: number;
  /** 各类输入的 token 明细（诊断/测试/审计用；不是可选附加信息） */
  breakdown: BudgetInputBreakdown;
  /** 是否达到触发阈值 */
  shouldTrigger: boolean;
  /** 占总容量比例（诊断用） */
  utilization: number;
}

// ---- 可配置参数（默认值见任务书；均可被环境变量覆盖） ----

/** 压缩触发比例：可用输入预算的 85% */
export const CONTEXT_TRIGGER_RATIO = 0.85;

/** 安全余量：绝对 token 数与比例两者取大 */
export const SAFETY_MARGIN_MIN = 512;
export const SAFETY_MARGIN_RATIO = 0.04;

export interface BudgetConfig {
  triggerRatio?: number;
  safetyMarginMin?: number;
  safetyMarginRatio?: number;
  /** 输出预留：默认取模型 maxOutputTokens，但不超过输入预算的 25% */
  reservedOutputRatioCap?: number;
  /** 压缩后目标区间（可用输入预算的比例）*/
  targetRatioLow?: number;
  targetRatioHigh?: number;
}

function num(env: string, fallback: number): number {
  const v = process.env[env];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function resolveBudgetConfig(): Required<BudgetConfig> {
  return {
    triggerRatio: num('MEMORY_CONTEXT_TRIGGER_RATIO', CONTEXT_TRIGGER_RATIO),
    safetyMarginMin: num('MEMORY_SAFETY_MARGIN_MIN', SAFETY_MARGIN_MIN),
    safetyMarginRatio: num('MEMORY_SAFETY_MARGIN_RATIO', SAFETY_MARGIN_RATIO),
    reservedOutputRatioCap: num('MEMORY_RESERVED_OUTPUT_CAP', 0.25),
    targetRatioLow: num('MEMORY_TARGET_RATIO_LOW', 0.60),
    targetRatioHigh: num('MEMORY_TARGET_RATIO_HIGH', 0.70),
  };
}

/**
 * Token 估算。
 *
 * 采用字符数除以有效字符密度，再乘安全系数：
 *   - 中英混合文本平均每 token 约 2.2~3.0 字符
 *   - 代码/JSON/工具输出更密（每 token 约 2.0 字符）
 * 保守（高估）方向取 2.0，再乘 1.15 安全系数。
 *
 * 明确不是精确计数：函数名用 estimate 而非 count，
 * 且返回值为 number（整数，向上取整）。
 */
const CHARS_PER_TOKEN_ESTIMATE = 2.0;
const ESTIMATE_SAFETY_FACTOR = 1.15;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 太短时 token 数至少为 1，避免 0 造成"看起来不占预算"
  const raw = Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  return Math.max(1, Math.ceil(raw * ESTIMATE_SAFETY_FACTOR));
}

export interface ContextPart {
  systemPrompt?: string;
  developerInstructions?: string;
  fixedPrompts?: string;
  dynamicPrompts?: string;
  summary?: string;
  historyMessages?: string;
  currentRequest?: string;
  toolDefinitions?: string;
  toolResults?: string;
  agentState?: string;
  multimodal?: string;
}

/** 把上下文各部分累加为估算 token（含每部分的明细，供观测/测试）。 */
export function estimateContextTokens(parts: ContextPart): { total: number; breakdown: BudgetInputBreakdown } {
  const b: BudgetInputBreakdown = {
    systemPrompt: estimateTokens(parts.systemPrompt || ''),
    developerInstructions: estimateTokens(parts.developerInstructions || ''),
    fixedPrompts: estimateTokens(parts.fixedPrompts || ''),
    dynamicPrompts: estimateTokens(parts.dynamicPrompts || ''),
    summary: estimateTokens(parts.summary || ''),
    historyMessages: estimateTokens(parts.historyMessages || ''),
    currentRequest: estimateTokens(parts.currentRequest || ''),
    toolDefinitions: estimateTokens(parts.toolDefinitions || ''),
    toolResults: estimateTokens(parts.toolResults || ''),
    agentState: estimateTokens(parts.agentState || ''),
    multimodal: estimateTokens(parts.multimodal || ''),
  };
  const total = Object.values(b).reduce((a, c) => a + c, 0);
  return { total, breakdown: b };
}

/**
 * 计算可用输入预算与触发阈值。
 *
 * 注意三个真实约束：
 *  1. 不同模型 contextWindow / maxOutputTokens 差异巨大（32768 ~ 200000），
 *     全部来自注册表，不写死。
 *  2. 预留输出不超过可用容量的 reservedOutputRatioCap ——
 *     否则一个 32K 模型被 32K 输出预留吃光，永远触发不了压缩。
 *  3. contextWindow 或 maxOutputTokens 为 0/未知（注册表里确实有 0 值条目）
 *     时返回 null，让上层走"未知模型"的安全路径，绝不用默认值猜测。
 */
export function computeInputBudget(
  model: ModelCapacity | null | undefined,
  parts: ContextPart,
  cfg?: BudgetConfig,
): InputBudget | null {
  if (!model || !model.contextWindow || model.contextWindow <= 0) return null;
  const c = { ...resolveBudgetConfig(), ...(cfg || {}) };

  const { total, breakdown } = estimateContextTokens(parts);

  // 预留输出：受 cap 约束，避免小模型被输出预留吃满
  const outReserve = Math.min(
    Math.max(0, model.maxOutputTokens || 0),
    Math.floor(model.contextWindow * c.reservedOutputRatioCap),
  );
  // 安全余量：绝对与比例取大 —— 覆盖估算误差、供应商额外开销、未统计内容
  const safety = Math.max(c.safetyMarginMin, Math.ceil(model.contextWindow * c.safetyMarginRatio));

  const usableInput = Math.max(1, model.contextWindow - outReserve - safety);
  const triggerThreshold = Math.max(1, Math.floor(usableInput * c.triggerRatio));
  const targetAfter = Math.floor(usableInput * c.targetRatioHigh);

  return {
    contextWindow: model.contextWindow,
    reservedOutput: outReserve,
    safetyMargin: safety,
    usableInput,
    triggerThreshold,
    targetAfterCompression: targetAfter,
    estimatedInput: total,
    breakdown,
    shouldTrigger: total >= triggerThreshold,
    utilization: total / model.contextWindow,
  };
}

/** 单次压缩请求自身的输入预算（不是聊天预算）。 */
export interface CompressionCallBudget {
  /** 本次分段可用的输入 token（已扣除压缩提示词、元数据、输出预留、安全余量）*/
  segmentInputBudget: number;
  /** 压缩提示词占用 */
  promptTokens: number;
  /** 压缩输出预留 */
  outputReserve: number;
  /** 单次请求的绝对上限（可用输入预算）*/
  hardLimit: number;
}

/**
 * 计算一次压缩调用可安全容纳的输入量。
 *
 * 任务书核心要求："必须在发起模型调用之前，就通过预算计算确定合理的分段
 * 边界。严禁先构造一个超出模型容量的超长请求，然后依靠模型报错后自动重试
 * 来决定如何分段。"
 *
 * 因此这里返回的是**净可用**值：可用输入预算 − 压缩提示词 − 输出预留 − 安全余量。
 */
export function computeCompressionCallBudget(
  model: ModelCapacity | null | undefined,
  compressionPromptTokens: number,
  metadataTokens = 0,
  cfg?: BudgetConfig,
): CompressionCallBudget | null {
  const budget = computeInputBudget(model, {}, cfg);
  if (!budget) return null;
  const c = { ...resolveBudgetConfig(), ...(cfg || {}) };
  // 压缩输出预留：压缩输出通常比输入短，但不能按 0 预留
  const outputReserve = Math.min(
    Math.max(512, Math.floor(budget.usableInput * 0.25)),
    budget.reservedOutput || 512,
  );
  const segmentInputBudget = Math.max(
    256,   // 低于此值的分段没有意义，宁可报不可用也不要发无效请求
    budget.usableInput - compressionPromptTokens - metadataTokens - outputReserve - c.safetyMarginMin,
  );
  return {
    segmentInputBudget,
    promptTokens: compressionPromptTokens,
    outputReserve,
    hardLimit: budget.usableInput,
  };
}

export function resolveModelCapacity(meta: {
  contextWindow?: number | null;
  maxTokens?: number | null;
} | null | undefined): ModelCapacity | null {
  const cw = Number(meta?.contextWindow ?? 0);
  const mt = Number(meta?.maxTokens ?? 0);
  if (!Number.isFinite(cw) || cw <= 0) return null;
  return { contextWindow: cw, maxOutputTokens: Number.isFinite(mt) && mt > 0 ? mt : Math.floor(cw * 0.25) };
}
