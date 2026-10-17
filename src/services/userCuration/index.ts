// ================================================================
// User Curation — 编排入口：触发判定 → 动态输入 → 模型 → 验证 → 执行 → 落状态
// ================================================================
// 职责边界：
//   - 意图分析器（taskTaxonomy / 媒体门等）负责"用户想做什么"；
//   - 本模块（记忆提取器）负责"这轮对话里有没有值得长期保存的用户信息"。
//     两者互不替代，也不把意图分类结果当作记忆。
// 成本与可靠性：
//   - 只有命中触发条件（明确保存/纠正/偏好信号，或抽样）才调用模型；
//   - 模型用 Agnes（callAgnes 统一层，小写模型名），失败即任务 failed，
//     不阻塞、不重试爆炸；
//   - CurationJob.dedupeKey 保证同一事件重复处理不重复写库（幂等）。
// ================================================================

import { createHash } from 'crypto';
import { prisma } from '../db';
import { callAgnes } from '../scenarioWorkers/agnesCaller';
import { CURATION_SYSTEM_PROMPT } from './prompt';
import { buildCuratorUserMessage, type CuratorExistingInput } from './builder';
import { parseCurationOutput } from './schema';
import { executeCandidateOps, type OpOutcome } from './executor';

export { CURATION_SYSTEM_PROMPT } from './prompt';

export interface CurationTrigger {
  kind: 'explicit' | 'correction' | 'auto';
  reason: string;
}

const EXPLICIT_PATTERNS = [
  /记住[，,。!！\s]/,
  /请记住/,
  /记下来/,
  /以后[都请要]/,
  /从现在开始/,
  /永远[都请]?这?样/,
  /每次[都请]/,
  /remember[,\s]/i,
  /please remember/i,
  /from now on/i,
  /always (?:do|use|answer)/i,
];

const CORRECTION_PATTERNS = [
  /记错了/,
  /你[之前先前]*记[的有错]/,
  /不[是对]/,
  /[.]其实[是应]/,
  /更正[一一下:：]/,
  /actually[,，\s]/i,
  /that('s| is) (?:wrong|not right)/i,
  /correction[:：]/i,
];

const PREFERENCE_SIGNAL_PATTERNS = [
  /我(更)?喜欢/,
  /我(希)望/,
  /请(用| always|始终|尽量)/,
  /(?:回答|解释)[要请].{0,6}(简洁|详细|中文|英文|步骤|表格)/,
  /(?:格式|风格|语气)[要请为是]/,
  /prefer[s]? (?:it|to|that)?/i,
  /i(?:'| a)?m more of a/i,
];

/**
 * 成本意识的触发判定：只有明确保存/纠正/偏好信号或抽样命中才触发，
 * 其余对话不调用整理模型（普通闲聊不值得花一次模型调用）。
 */
export function shouldCurate(userMessage: string, assistantResponse: string, messageCount = 0): CurationTrigger | null {
  const msg = userMessage || '';
  for (const p of EXPLICIT_PATTERNS) {
    if (p.test(msg)) return { kind: 'explicit', reason: `explicit pattern: ${p.source}` };
  }
  for (const p of CORRECTION_PATTERNS) {
    if (p.test(msg)) return { kind: 'correction', reason: `correction pattern: ${p.source}` };
  }
  for (const p of PREFERENCE_SIGNAL_PATTERNS) {
    if (p.test(msg)) return { kind: 'auto', reason: `preference signal: ${p.source}` };
  }
  // 周期性抽样兜底（约每 8 条消息一次），捕获未被规则识别的长期信息
  if (messageCount > 0 && messageCount % 8 === 0 && (msg.length > 60 || assistantResponse.length > 400)) {
    return { kind: 'auto', reason: `periodic sample at message #${messageCount}` };
  }
  return null;
}

function buildDedupeKey(userId: string, conversationId: string, userMessage: string): string {
  const normalized = userMessage.replace(/\s+/g, ' ').trim().slice(0, 200);
  return createHash('sha256')
    .update(`${userId}|${conversationId}|${normalized}`)
    .digest('hex')
    .slice(0, 40);
}

/** 拉取与本次事件可能相关的既有记录（限量，绝不注入全部历史）。 */
async function loadExistingRecords(userId: string, userMessage: string): Promise<CuratorExistingInput> {
  const keywords = (userMessage.match(/[\u4e00-\u9fa5]{2,}|[a-z]{3,}/gi) || []).slice(0, 3);
  const [preferences, requirements, longTermMemories] = await Promise.all([
    prisma.userPreference.findMany({
      where: { userId, status: 'active' },
      orderBy: [{ confidence: 'desc' }, { lastObservedAt: 'desc' }],
      take: 12,
    }).catch(() => []),
    prisma.userRequirement.findMany({
      where: { userId, status: 'active' },
      orderBy: { updatedAt: 'desc' },
      take: 12,
    }).catch(() => []),
    prisma.longTermMemory.findMany({
      where: {
        userId,
        status: 'active',
        ...(keywords.length > 0
          ? { OR: keywords.map((k) => ({ content: { contains: k } })) }
          : {}),
      },
      orderBy: [{ importance: 'desc' }, { lastObservedAt: 'desc' }],
      take: 12,
    }).catch(() => []),
  ]);

  // 关键词没命中时，兜底带最近的高重要度长期记忆（避免模型完全看不到旧记录）
  let longTerm = longTermMemories;
  if (longTerm.length === 0 && keywords.length > 0) {
    longTerm = await prisma.longTermMemory.findMany({
      where: { userId, status: 'active' },
      orderBy: [{ importance: 'desc' }, { lastObservedAt: 'desc' }],
      take: 6,
    }).catch(() => []);
  }

  const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : '');
  return {
    preferences: preferences.map((p: any) => ({ id: p.id, type: p.type, category: p.category, content: p.content, confidence: p.confidence, updatedAt: iso(p.updatedAt) })),
    requirements: requirements.map((r: any) => ({ id: r.id, category: r.category, content: r.content, priority: r.priority, updatedAt: iso(r.updatedAt) })),
    longTermMemories: longTerm.map((m: any) => ({
      id: m.id, type: m.type, subtype: m.subtype ?? undefined, content: m.content,
      importance: m.importance, domain: m.domain ?? null, updatedAt: iso(m.updatedAt),
    })),
  };
}

export interface CurationRunResult {
  jobId: string | null;
  status: 'saved' | 'noop' | 'review' | 'partial' | 'failed' | 'deduped';
  outcomes: OpOutcome[];
  error?: string;
}

/**
 * 运行一次「用户信息整理」闭环：模型分析 → 结构校验 → 后端执行 → 真实落库。
 * 任何一步失败都不会抛出到调用方（chat 流已 fire-and-forget）。
 */
export async function runUserCuration(opts: {
  userId: string;              // 由可信认证决定，绝不来自消息内容/模型输出
  conversationId: string;
  userMessage: string;
  assistantResponse: string;
  recentMessages?: Array<{ role: string; content: string }>;
  trigger?: CurationTrigger;
  messageCount?: number;
}): Promise<CurationRunResult> {
  const { userId, conversationId, userMessage, assistantResponse } = opts;
  const trigger = opts.trigger ?? shouldCurate(userMessage, assistantResponse, opts.messageCount ?? 0);
  if (!trigger) return { jobId: null, status: 'noop', outcomes: [] };

  const dedupeKey = buildDedupeKey(userId, conversationId, userMessage);
  try {
    // —— 幂等：同一事件只处理一次（唯一约束兜底并发） ——
    const existingJob = await prisma.curationJob.findUnique({ where: { dedupeKey } });
    if (existingJob) {
      return { jobId: existingJob.id, status: 'deduped', outcomes: [] };
    }

    const job = await prisma.curationJob.create({
      data: {
        userId,
        conversationId,
        dedupeKey,
        status: 'analyzed',
        trigger: trigger.kind,
      },
    });

    // —— 动态输入（与系统提示词分离） ——
    const existing = await loadExistingRecords(userId, userMessage);
    const userMessagePrompt = buildCuratorUserMessage({
      event: {
        userMessage,
        assistantResponse,
        conversationId,
        recentMessages: opts.recentMessages ?? [{ role: 'user', content: userMessage }],
      },
      existing,
      constraints: [
        'Do not store passwords, API keys, access tokens, or other secrets.',
        'Do not generalize expertise from one domain to another.',
        'Project-scoped facts must keep scope=PROJECT; do not promote them to USER scope.',
        'A one-time instruction for the current answer is TEMPORARY, not a durable preference.',
      ],
    });

    // —— 模型调用（Agnes 统一层，结构化 JSON 契约） ——
    const raw = await callAgnes(CURATION_SYSTEM_PROMPT, userMessagePrompt, {
      model: 'agnes-2.5-flash',
      temperature: 0.1,
      maxTokens: 1400,
      timeoutMs: 30_000,
    });

    const parsed = parseCurationOutput(raw);
    if (!parsed.ok) {
      await prisma.curationJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          errorSummary: parsed.errors.map((e) => `${e.field}:${e.message}`).join('; ').slice(0, 400),
          opsJson: JSON.stringify([]),
          completedAt: new Date(),
        },
      });
      return { jobId: job.id, status: 'failed', outcomes: [], error: 'output validation failed' };
    }

    await prisma.curationJob.update({
      where: { id: job.id },
      data: { opsJson: JSON.stringify(parsed.output!.candidates) },
    });

    // —— 后端执行（所有权校验 + 真实写库） ——
    const outcomes = await executeCandidateOps(userId, parsed.output!.candidates, conversationId);

    const hasSaved = outcomes.some((o) => o.status === 'saved' || o.status === 'reinforced');
    const hasReview = outcomes.some((o) => o.status === 'review' || o.status === 'review_target_not_found');
    const hasFailed = outcomes.some((o) => o.status === 'failed');
    const finalStatus: CurationRunResult['status'] = hasFailed
      ? 'partial'
      : hasSaved
        ? (hasReview ? 'partial' : 'saved')
        : (hasReview ? 'review' : 'noop');

    await prisma.curationJob.update({
      where: { id: job.id },
      data: {
        status: finalStatus,
        appliedJson: JSON.stringify(outcomes),
        completedAt: new Date(),
      },
    });

    return { jobId: job.id, status: finalStatus, outcomes };
  } catch (err: any) {
    console.error('[Curation] run error:', err?.message ?? err);
    try {
      await prisma.curationJob.updateMany({
        where: { dedupeKey },
        data: { status: 'failed', errorSummary: String(err?.message ?? err).slice(0, 400), completedAt: new Date() },
      });
    } catch { /* 状态回写失败不再向上抛 */ }
    return { jobId: null, status: 'failed', outcomes: [], error: String(err?.message ?? err) };
  }
}
