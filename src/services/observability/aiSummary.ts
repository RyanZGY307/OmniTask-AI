// ================================================================
// 观测中心 — AI 运行摘要投影（只读）
// ================================================================
// 边界：本模块只读既有任务表/链路表，**不修改、不包装、不 hook**
//   进化引擎 / 自净化 / researchExecutor / orgRuntime 的内部逻辑。
//   摘要是从「系统已经落库的真实状态」投影出来的，因此：
//     · 没有记录的字段 → 明确返回 null，由前端显示「未接入」；
//     · 绝不用推测值、模拟值填充。
//
// 四段分离（前端分区展示，禁止混为一谈）：
//   decision = AI 提出的计划（planJson/resultJson 投影）
//   guard    = 程序化安全门禁结果（**当前系统没有该机制 → null**）
//   tools    = 实际工具调用事件（ToolCall 投影，未关联则为空并说明原因）
//   outcome  = 执行后的实测结果（status/lastError/completedAt 投影）
//
// 24h 生命周期：expiresAt = 任务 createdAt + 24h（锚定任务开始时刻，
//   而非同步时刻）。所有读接口 SQL 强制 expiresAt > now()。
// ================================================================

import { prismaUser } from '../db';
import { computeExpiresAt, redact, jsonSafe, type RedactResult } from './pgStats';

export type TaskKind =
  | 'research' | 'organization' | 'evolution' | 'refresh'
  | 'skillAnalysis' | 'modelProfile' | 'contextCompression'
  | 'verification' | 'chat';

interface JobSource {
  kind: TaskKind;
  delegate: any;   // prismaUser.researchJob / ...
  label: string;
  /** 从任务行提取摘要正文与关联信息 */
  pick: (j: any) => {
    status: string; goal: string | null; summary: string;
    decisionJson: string | null; completedAt: Date | null;
  };
}

const GUARD_UNAVAILABLE = JSON.stringify({
  available: false,
  reason: '当前系统没有程序化数据库安全门禁机制，未接入',
});

const TOOLS_NOT_LINKED = JSON.stringify({
  linked: false,
  reason: '该任务类型未与 RequestTrace/ToolCall 建立关联，无法投影实际工具调用',
});

function safeParse(raw: unknown): any {
  if (!raw || typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function planSummary(raw: unknown): { goal: string | null; plan: any } {
  const p = safeParse(raw);
  if (!p) return { goal: null, plan: null };
  const goal: string | null =
    p.goal ?? p.objective ?? p.target ?? p.rootTask ?? p.triggerReason ?? null;
  return { goal: typeof goal === 'string' ? goal : null, plan: p };
}

const SOURCES: JobSource[] = [
  {
    kind: 'research', label: '研究任务', delegate: null as any,
    pick: (j) => {
      const { goal, plan } = planSummary(j.planJson);
      const res = safeParse(j.resultJson);
      const parts: string[] = [`研究对象=${j.objectId ?? '未知'}`, `类型=${j.jobType ?? '未知'}`];
      if (j.triggerType) parts.push(`触发=${j.triggerType}`);
      if (j.status) parts.push(`状态=${j.status}`);
      if (j.attemptCount > 0) parts.push(`第${j.attemptCount}次尝试`);
      if (j.lastError) parts.push(`错误=${j.lastError}`);
      if (res?.factsFound != null) parts.push(`产出事实=${res.factsFound}`);
      return {
        status: j.status, goal, completedAt: j.completedAt,
        summary: parts.join('；'),
        decisionJson: JSON.stringify({ candidates: plan?.candidates ?? null, chosenReason: plan?.reason ?? null, plan }),
      };
    },
  },
  {
    kind: 'organization', label: '组织任务', delegate: null as any,
    pick: (j) => {
      const { goal, plan } = planSummary(j.planJson);
      const parts: string[] = [`范围=${j.scopeType}/${j.scopeId}`, `触发=${j.triggerReason ?? '未知'}`, `状态=${j.status}`];
      if (j.attemptCount > 0) parts.push(`第${j.attemptCount}次尝试`);
      if (j.lastError) parts.push(`错误=${j.lastError}`);
      return {
        status: j.status, goal, completedAt: j.completedAt,
        summary: parts.join('；'),
        decisionJson: JSON.stringify({ plan, scope: `${j.scopeType}/${j.scopeId}` }),
      };
    },
  },
  {
    kind: 'evolution', label: '进化任务', delegate: null as any,
    pick: (j) => {
      const res = safeParse(j.resultJson);
      const parts: string[] = [`会话=${j.conversationId}`, `状态=${j.status}`];
      if (res?.signalType) parts.push(`信号=${res.signalType}`);
      if (res?.candidates?.length) parts.push(`候选数=${res.candidates.length}`);
      if (j.lastError) parts.push(`错误=${j.lastError}`);
      return {
        status: j.status, goal: res?.signalType ? `处理用户信号 ${res.signalType}` : null,
        completedAt: j.completedAt, summary: parts.join('；'),
        decisionJson: JSON.stringify({ candidates: res?.candidates ?? null }),
      };
    },
  },
  {
    kind: 'refresh', label: '知识刷新任务', delegate: null as any,
    pick: (j) => {
      const parts: string[] = [`事实=${j.factId}`, `周期=${j.refreshCycle ?? '未知'}`, `状态=${j.status}`];
      if (j.reason) parts.push(`原因=${j.reason}`);
      if (j.lastError) parts.push(`错误=${j.lastError}`);
      return {
        status: j.status, goal: j.reason ?? null, completedAt: j.completedAt,
        summary: parts.join('；'), decisionJson: null,
      };
    },
  },
  {
    kind: 'skillAnalysis', label: 'Skill 分析任务', delegate: null as any,
    pick: (j) => {
      const parts: string[] = [`技能=${j.skillId}`, `状态=${j.status}`];
      if (j.trigger) parts.push(`触发=${j.trigger}`);
      if (j.lastError) parts.push(`错误=${j.lastError}`);
      return {
        status: j.status, goal: j.trigger ?? null, completedAt: j.completedAt,
        summary: parts.join('；'), decisionJson: null,
      };
    },
  },
  {
    kind: 'modelProfile', label: '模型画像任务', delegate: null as any,
    pick: (j) => {
      const parts: string[] = [`模型=${j.modelId ?? '未知'}/${j.provider ?? '未知'}`, `场景=${j.scenarioId ?? '未知'}`, `状态=${j.status}`];
      if (j.lastError) parts.push(`错误=${j.lastError}`);
      return {
        status: j.status, goal: `构建 ${j.modelId ?? ''} 画像`,
        completedAt: j.completedAt, summary: parts.join('；'), decisionJson: null,
      };
    },
  },
  {
    kind: 'contextCompression', label: '记忆压缩任务', delegate: null as any,
    pick: (j) => {
      const parts: string[] = [`会话=${j.conversationId}`, `触发=${j.trigger ?? '未知'}`, `状态=${j.status}`];
      if (j.compressionVersion > 1) parts.push(`版本=${j.compressionVersion}`);
      if (j.lastError) parts.push(`错误=${j.lastError}`);
      return {
        status: j.status, goal: j.trigger ?? null, completedAt: j.completedAt,
        summary: parts.join('；'), decisionJson: null,
      };
    },
  },
  {
    kind: 'verification', label: '校验任务', delegate: null as any,
    pick: (j) => {
      const parts: string[] = [`纠正事件=${j.correctionEventId}`, `状态=${j.status}`];
      if (j.lastError) parts.push(`错误=${j.lastError}`);
      return {
        status: j.status, goal: '验证用户纠正后的知识',
        completedAt: j.completedAt, summary: parts.join('；'),
        decisionJson: j.queriesJson ? JSON.stringify({ queries: safeParse(j.queriesJson) }) : null,
      };
    },
  },
];

/** 绑定 prismaUser 上的真实 delegate（prisma 模型名与 kind 的映射）。 */
export function bindJobSources() {
  const map: Record<string, any> = {
    research: (prismaUser as any).researchJob,
    organization: (prismaUser as any).organizationJob,
    evolution: (prismaUser as any).evolutionJob,
    refresh: (prismaUser as any).refreshTask,
    skillAnalysis: (prismaUser as any).skillAnalysisJob,
    modelProfile: (prismaUser as any).modelProfileJob,
    contextCompression: (prismaUser as any).contextCompressionJob,
    verification: (prismaUser as any).verificationJob,
  };
  for (const s of SOURCES) s.delegate = map[s.kind] ?? null;
  return SOURCES;
}

// 同步窗口取 25h（略大于 24h 保留期）：只同步「可能仍在 24h 窗口内」的任务，
// 超过 24h 的旧任务不再投影，其既有摘要行交给清理器删除。
const SYNC_WINDOW_HOURS = 25;

/**
 * 把近期任务投影成 AiRunSummary（幂等 upsert，按 taskId+taskKind 唯一）。
 * 任何单源失败不影响其他源。
 */
export async function syncAiRunSummaries(now = new Date()): Promise<{ upserted: number; failed: number }> {
  bindJobSources();
  const since = new Date(now.getTime() - SYNC_WINDOW_HOURS * 3600 * 1000);
  let upserted = 0, failed = 0;

  for (const src of SOURCES) {
    if (!src.delegate) { failed++; continue; }
    try {
      const rows = await src.delegate.findMany({
        where: { updatedAt: { gte: since } },
        orderBy: { updatedAt: 'desc' }, take: 100,
      });
      for (const j of rows) {
        const picked = src.pick(j);
        const createdAt: Date = j.createdAt ?? j.queuedAt ?? now;
        const expiresAt = computeExpiresAt(createdAt);
        // 已过期的任务直接跳过（不写入，交给清理器）
        if (expiresAt.getTime() <= now.getTime()) continue;

        const rr: RedactResult = redact(picked.summary);
        const dr: RedactResult = redact(picked.decisionJson ?? '');
        const applied = [...new Set([...rr.applied, ...dr.applied])].join(',');

        await prismaUser.aiRunSummary.upsert({
          where: { taskId_taskKind: { taskId: j.id, taskKind: src.kind } },
          create: jsonSafe({
            taskId: j.id, taskKind: src.kind, createdAt, expiresAt,
            summary: rr.text,
            triggerSource: String(j.triggerType ?? j.trigger ?? 'unknown'),
            status: String(picked.status ?? 'unknown'),
            goal: picked.goal, startedAt: j.startedAt ?? null, completedAt: picked.completedAt ?? null,
            decisionJson: dr.text || null,
            guardJson: null,                       // 未接入，见文件头
            toolsJson: TOOLS_NOT_LINKED,            // 未关联，见文件头
            outcomeJson: JSON.stringify({
              status: picked.status, lastError: j.lastError ?? null,
              attemptCount: j.attemptCount ?? null, workerId: j.workerId ?? null,
            }),
            redactionApplied: applied, createdAtRow: now,
          }),
          update: jsonSafe({
            summary: rr.text, status: String(picked.status ?? 'unknown'),
            decisionJson: dr.text || null,
            outcomeJson: JSON.stringify({
              status: picked.status, lastError: j.lastError ?? null,
              attemptCount: j.attemptCount ?? null, workerId: j.workerId ?? null,
            }),
            completedAt: picked.completedAt ?? null,
            redactionApplied: applied, createdAtRow: now,
            // expiresAt 不变：跟随任务 createdAt 计算，不因同步而顺延
          }),
        });
        upserted++;
      }
    } catch { failed++; }
  }
  return { upserted, failed };
}

/**
 * 链路类（chat）摘要投影：RequestTrace 自带 selectionReason /
 * candidateModels / tokens / credits，是 richest 的决策记录，且通过
 * RequestTrace→ToolCall/ModelCall 能投影到「实际工具执行」。
 */
export async function syncChatRunSummaries(now = new Date(), limit = 100): Promise<{ upserted: number }> {
  const since = new Date(now.getTime() - SYNC_WINDOW_HOURS * 3600 * 1000);
  let upserted = 0;
  try {
    const traces = await prismaUser.requestTrace.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' }, take: limit,
      include: {
        modelCalls: { select: { provider: true, selectedModel: true, status: true, httpStatus: true, errorMessage: true, totalTokens: true } },
        toolCalls: { select: { toolName: true, status: true, errorCode: true, durationMs: true } },
      },
    });
    for (const t of traces as any[]) {
      const createdAt: Date = t.createdAt ?? now;
      const expiresAt = computeExpiresAt(createdAt);
      if (expiresAt.getTime() <= now.getTime()) continue;
      const rr: RedactResult = redact(
        `模型=${t.selectedModel ?? t.requestedModel ?? '未知'}/${t.provider ?? '未知'};` +
        `路由=${t.routingMode ?? '未知'};状态=${t.status};` +
        `选用理由=${t.selectionReason ?? '未记录'};候选=${t.candidateModels ?? '未记录'}`,
      );
      const tools = (t.toolCalls ?? []).map((x: any) => ({
        name: x.toolName, status: x.status, errorCode: x.errorCode, durationMs: x.durationMs,
      }));
      const outcome = {
        status: t.status, finishReason: t.finishReason ?? null,
        totalTokens: t.totalTokens ?? null, creditsCharged: t.creditsCharged ?? null,
        durationMs: t.durationMs ?? null, ttftMs: t.ttftMs ?? null,
        metricsAfterNote: 'TTFT/时长/token/费用为实测值；无 pg_stat_statements 故无库级前后指标',
      };
      const appliedSet = [...rr.applied];
      await prismaUser.aiRunSummary.upsert({
        where: { taskId_taskKind: { taskId: t.requestId ?? t.id, taskKind: 'chat' } },
        create: jsonSafe({
          taskId: t.requestId ?? t.id, taskKind: 'chat', createdAt, expiresAt,
          summary: rr.text, triggerSource: t.routingPolicy ? `policy:${t.routingPolicy}` : 'user_request',
          status: String(t.status ?? 'unknown'), goal: t.mode ? `模式 ${t.mode} 的模型路由决策` : '模型路由决策',
          startedAt: t.startedAt ?? null, completedAt: t.completedAt ?? null,
          modelUsed: t.selectedModel ?? null, agentName: null,
          decisionJson: JSON.stringify({
            requestedModel: t.requestedModel ?? null, selectedModel: t.selectedModel ?? null,
            candidateModels: safeParse(t.candidateModels), selectionReason: redact(t.selectionReason ?? '').text,
            routingMode: t.routingMode ?? null, routingPolicy: t.routingPolicy ?? null,
          }),
          guardJson: null,
          toolsJson: tools.length ? JSON.stringify({ linked: true, items: tools }) : TOOLS_NOT_LINKED,
          outcomeJson: JSON.stringify(outcome),
          redactionApplied: [...new Set(appliedSet)].join(','), createdAtRow: now,
        }),
        update: jsonSafe({
          summary: rr.text, status: String(t.status ?? 'unknown'),
          decisionJson: JSON.stringify({
            requestedModel: t.requestedModel ?? null, selectedModel: t.selectedModel ?? null,
            candidateModels: safeParse(t.candidateModels), selectionReason: redact(t.selectionReason ?? '').text,
            routingMode: t.routingMode ?? null, routingPolicy: t.routingPolicy ?? null,
          }),
          toolsJson: tools.length ? JSON.stringify({ linked: true, items: tools }) : TOOLS_NOT_LINKED,
          outcomeJson: JSON.stringify(outcome),
          redactionApplied: [...new Set(appliedSet)].join(','), createdAtRow: now,
        }),
      });
      upserted++;
    }
  } catch { /* 链路投影失败不影响其他源 */ }
  return { upserted };
}
