// ================================================================
// Evolution Engine — System-level evolution (Knowledge DB + User DB)
// ================================================================
//
// Evolution candidates/signals live in cortex_knowledge.
// User lookups live in cortex_user.

import { prismaUser, prismaKnowledge, prismaConversation } from './db';
import { getTokenCosts } from './evolutionBudget';
import { log } from './logger';
import { callAgnes } from './scenarioWorkers/agnesCaller';

// ==================== Signal Detection ====================

const NEGATIVE_KEYWORDS = ['不对', '错了', '错误', '重新', '重来', '不行', '不好', '再试', '不是这样', '错了错了', 'wrong', 'incorrect', 'retry', 'fix', 'bug'];
const POSITIVE_KEYWORDS = ['很好', '完美', '正确', '对了', '不错', '厉害', '好的', 'perfect', 'correct', 'great', 'good job'];

export interface DetectedSignal {
  type: string;
  severity: string;
  detail: string;
  messageId?: string;
  conversationId?: string;
}

export async function detectSignals(messages: any[], userId: string, region?: string): Promise<DetectedSignal[]> {
  const signals: DetectedSignal[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const span = msg.metadata?.span;

    if (msg.role === 'user' && i > 0) {
      const prev = messages[i - 1];
      if (prev.role === 'assistant') {
        const lower = msg.content.toLowerCase();
        const isNeg = NEGATIVE_KEYWORDS.some(kw => lower.includes(kw));
        const isPos = POSITIVE_KEYWORDS.some(kw => lower.includes(kw));
        if (isNeg) {
          signals.push({ type: 'user_correction', severity: 'medium', detail: `用户否定: "${msg.content.substring(0, 100)}"`, messageId: msg.id, conversationId: msg.conversationId });
        }
        if (isPos) {
          signals.push({ type: 'positive_feedback', severity: 'low', detail: `用户肯定: "${msg.content.substring(0, 100)}"`, messageId: msg.id, conversationId: msg.conversationId });
        }
      }
    }

    if (msg.role === 'assistant' && span?.tool_calls) {
      for (const tc of span.tool_calls) {
        if (tc.status && tc.status !== 'ok' && tc.status !== 'success') {
          signals.push({ type: 'tool_error', severity: 'medium', detail: `工具错误: ${tc.tool} → ${tc.status}`, messageId: msg.id });
        }
      }
    }

    if (span?.duration_ms && span.duration_ms > 30000) {
      signals.push({ type: 'timeout', severity: 'low', detail: `响应超时: ${span.duration_ms}ms`, messageId: msg.id });
    }

    if (span?.fallback_from) {
      signals.push({ type: 'retry_spike', severity: 'low', detail: `模型回退: ${span.fallback_from} → ${span.selected_model}`, messageId: msg.id });
    }

    if (msg.role === 'assistant' && span && span.rag_chunks_retrieved === 0 && span.mode !== 'fast') {
      const nextUser = messages[i + 1];
      if (nextUser?.role === 'user' && (nextUser.content.includes('为什么') || nextUser.content.includes('怎么') || nextUser.content.includes('how') || nextUser.content.includes('why'))) {
        signals.push({ type: 'retrieval_miss', severity: 'low', detail: `RAG检索0条结果，用户追问`, messageId: msg.id });
      }
    }

    if (msg.messageType === 'feedback') {
      signals.push({ type: 'user_correction', severity: 'high', detail: `显式反馈: "${msg.content.substring(0, 100)}"`, messageId: msg.id, conversationId: msg.conversationId });
    }
  }

  const seen = new Set<string>();
  return signals.filter(s => {
    const key = `${s.type}:${s.conversationId || 'none'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ========== Agnes Attribution ==========

export async function agnesAttribute(signal: DetectedSignal): Promise<{ worthEvolving: boolean; assetType: string; reason: string }> {
  const costs = getTokenCosts();
  const poolOk = await checkSystemPool(costs.signalAttribution);
  if (!poolOk.allowed) return { worthEvolving: false, assetType: 'unknown', reason: '系统预算耗尽' };

  // Deterministic attribution (no LLM): the caller already pre-filtered to
  // high-value, non-low-severity signals; the asset type mirrors the mapping
  // in buildCandidate that immediately follows.
  const assetType = signalToAssetType(signal.type);
  await consumeSystemPool(costs.signalAttribution);
  return {
    worthEvolving: true,
    assetType,
    reason: `${signal.type} → ${assetType}（确定性归因，规则层已判为高价值）`,
  };
}

// signal.type -> evolution asset type (mirrors buildCandidate's routing).
function signalToAssetType(type: string): string {
  switch (type) {
    case 'user_correction':
    case 'positive_feedback':
    case 'repeated_failure':
      return 'memory';
    case 'retrieval_miss':
      return 'knowledge';
    case 'tool_error':
    case 'timeout':
    case 'retry_spike':
      return 'procedure';
    default:
      return 'memory';
  }
}

// ========== Candidate Building ==========

export interface BuiltCandidate {
  scope: string;
  changeType: string;
  targetType: string;
  hypothesis: string;
  content: string;
  evidenceRefs: string[];
  region?: string;
  userId?: string;
  blastRadius: string;
  gateLevel: number;
  confidence: number;
}

export async function buildCandidate(signal: DetectedSignal, userId: string, region?: string): Promise<BuiltCandidate> {
  let scope = 'PERSONAL';
  let changeType = 'CAPTURE';
  let blastRadius = 'low';
  let gateLevel = 1;
  let confidence = 0.6;

  if (signal.type === 'user_correction' || signal.type === 'positive_feedback') {
    scope = 'PERSONAL'; gateLevel = 1; blastRadius = 'low'; confidence = 0.7;
  } else if (signal.type === 'retrieval_miss' || signal.type === 'timeout') {
    if (region) {
      const regionCount = await prismaKnowledge.evolutionSignal.count({
        where: { region, signalType: signal.type, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      });
      if (regionCount >= 3) { scope = 'TEAM'; gateLevel = 2; blastRadius = 'medium'; confidence = 0.65; }
    }
  } else if (signal.type === 'tool_error' || signal.type === 'retry_spike') {
    scope = 'TEAM'; gateLevel = 2; blastRadius = 'medium'; confidence = 0.6;
  }

  if (signal.type === 'user_correction') changeType = 'FIX';
  if (signal.type === 'positive_feedback') changeType = 'CAPTURE';
  if (signal.type === 'retrieval_miss') changeType = 'DERIVE';
  if (signal.type === 'tool_error') changeType = 'FIX';
  if (signal.type === 'retry_spike') changeType = 'OPTIMIZE';

  if (signal.severity === 'high') { if (gateLevel < 2) gateLevel = 2; if (blastRadius === 'low') blastRadius = 'medium'; }

  let content = '';
  let targetType = 'memory';
  let hypothesis = '';

  if (signal.type === 'user_correction') { content = signal.detail; targetType = 'memory'; hypothesis = '记录用户纠正，避免重复同类错误'; }
  else if (signal.type === 'positive_feedback') { content = `用户确认有效的做法: ${signal.detail}`; targetType = 'memory'; hypothesis = '记录成功模式，未来复用'; }
  else if (signal.type === 'retrieval_miss') { content = `知识检索未命中: ${signal.detail}`; targetType = 'knowledge'; hypothesis = '补充缺失知识'; gateLevel = Math.max(gateLevel, 2); }
  else if (signal.type === 'tool_error') { content = `工具错误模式: ${signal.detail}`; targetType = 'procedure'; hypothesis = '修复工具调用错误'; gateLevel = Math.max(gateLevel, 2); }
  else if (signal.type === 'timeout') { content = `响应超时模式: ${signal.detail}`; targetType = 'procedure'; hypothesis = '优化超时场景'; }
  else if (signal.type === 'retry_spike') { content = `模型回退模式: ${signal.detail}`; targetType = 'procedure'; hypothesis = '优化模型选择策略'; gateLevel = Math.max(gateLevel, 2); }

  return { scope, changeType, targetType, hypothesis, content, evidenceRefs: [signal.messageId || ''].filter(Boolean), region, userId, blastRadius, gateLevel, confidence };
}

// ========== Gate System ==========

export async function gate1Promote(candidateId: string): Promise<boolean> {
  const candidate = await prismaKnowledge.evolutionCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) return false;

  // Memory writes go to User DB
  if (candidate.targetType === 'memory' && candidate.userId) {
    const existing = await prismaUser.memoryEntry.findFirst({
      where: { userId: candidate.userId, isActive: true, content: { contains: candidate.content.substring(0, 30) } },
    });
    if (!existing) {
      await prismaUser.memoryEntry.create({
        data: { userId: candidate.userId, content: candidate.content, category: 'evolution', level: 3, source: `evolution:${candidate.id}` },
      });
    }
  }

  await prismaKnowledge.evolutionCandidate.update({ where: { id: candidateId }, data: { status: 'promoted', promotedAt: new Date() } });
  await prismaKnowledge.evolutionAudit.create({ data: { action: 'gate1_promote', candidateId, scope: candidate.scope, reason: '低风险，即时生效' } });
  await incrementBudgetCounter('promoteCount');
  log('INFO', '进化Gate1通过', `${candidate.scope}:${candidate.changeType} ${candidate.content.substring(0, 80)}`, candidate.userId || undefined);
  return true;
}

export async function gate2Evaluate(candidateId: string): Promise<{ pass: boolean; reason: string }> {
  const candidate = await prismaKnowledge.evolutionCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) return { pass: false, reason: '候选不存在' };

  const costs = getTokenCosts();
  const poolOk = await checkSystemPool(costs.gate2Evaluate);
  if (!poolOk.allowed) return { pass: false, reason: '系统预算不足' };

  try {
    const text = await callAgnes(
      '你是 OmniTask 进化引擎的安全与质量评估员。评估候选变更是否安全、有效。只输出JSON。',
      `候选变更：\n作用域: ${candidate.scope}\n变更类型: ${candidate.changeType}\n内容: ${candidate.content}\n假说: ${candidate.hypothesis}\n\n输出JSON：{"safe": true/false, "quality": "improved|same|degraded", "pass": true/false, "reason": "简短理由"}`,
      { maxTokens: 150 },
    );

    await consumeSystemPool(costs.gate2Evaluate);

    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return { pass: false, reason: '评估解析失败' };
    const result = JSON.parse(match[0]);

    await prismaKnowledge.evaluationReport.create({
      data: { candidateId, securityPassed: result.safe || false, qualityScore: result.quality === 'improved' ? 0.8 : result.quality === 'same' ? 0.5 : 0.2, decision: result.pass ? 'pass' : 'reject', agnesAssessment: text },
    });

    if (result.safe && result.quality !== 'degraded' && result.pass) {
      if (candidate.scope === 'TEAM' && candidate.region) {
        await prismaKnowledge.regionInsight.create({ data: { region: candidate.region, insight: candidate.content, confidence: candidate.confidence, candidateId } });
      }
      await prismaKnowledge.evolutionCandidate.update({ where: { id: candidateId }, data: { status: 'promoted', promotedAt: new Date() } });
      await prismaKnowledge.evolutionAudit.create({ data: { action: 'gate2_promote', candidateId, scope: candidate.scope, reason: result.reason } });
      await incrementBudgetCounter('promoteCount');
      log('INFO', '进化Gate2通过', `${candidate.scope}:${candidate.changeType}`, candidate.userId || undefined);
      return { pass: true, reason: result.reason };
    } else {
      await prismaKnowledge.evolutionCandidate.update({ where: { id: candidateId }, data: { status: 'rejected', rejectedAt: new Date(), rejectReason: result.reason } });
      await prismaKnowledge.evolutionAudit.create({ data: { action: 'gate2_reject', candidateId, scope: candidate.scope, reason: result.reason } });
      await incrementBudgetCounter('rejectCount');
      return { pass: false, reason: result.reason };
    }
  } catch (err: any) {
    return { pass: false, reason: '评估异常: ' + (err.message || '') };
  }
}

export async function gate3Evaluate(candidateId: string): Promise<{ pass: boolean; reason: string }> {
  const candidate = await prismaKnowledge.evolutionCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) return { pass: false, reason: '候选不存在' };

  const costs = getTokenCosts();
  const poolOk = await checkSystemPool(costs.gate3Evaluate);
  if (!poolOk.allowed) return { pass: false, reason: '系统预算不足' };

  try {
    const text = await callAgnes(
      '你是 OmniTask 进化引擎的高级评估员。对全局候选变更进行严格评估。只输出JSON。',
      `全局候选变更：\n变更类型: ${candidate.changeType}\n内容: ${candidate.content}\n假说: ${candidate.hypothesis}\n\n输出JSON：{"safe": true/false, "qualityScore": 0-1, "regressionRisk": "low|medium|high", "pass": true/false, "needHumanApproval": true/false, "reason": "详细理由"}`,
      { maxTokens: 250 },
    );

    await consumeSystemPool(costs.gate3Evaluate);

    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return { pass: false, reason: '评估解析失败' };
    const result = JSON.parse(match[0]);

    await prismaKnowledge.evaluationReport.create({
      data: { candidateId, securityPassed: result.safe || false, qualityScore: result.qualityScore || 0, regressionPassed: result.regressionRisk === 'low' ? 1 : 0, regressionFailed: result.regressionRisk !== 'low' ? 1 : 0, agnesAssessment: text, decision: result.pass ? (result.needHumanApproval ? 'pending_approval' : 'pass') : 'reject' },
    });

    if (!result.safe) {
      await prismaKnowledge.evolutionCandidate.update({ where: { id: candidateId }, data: { status: 'rejected', rejectedAt: new Date(), rejectReason: '安全检查未通过: ' + result.reason } });
      await incrementBudgetCounter('rejectCount');
      return { pass: false, reason: '安全检查未通过' };
    }

    if (result.pass) {
      if (result.needHumanApproval) {
        await prismaKnowledge.evolutionCandidate.update({ where: { id: candidateId }, data: { status: 'awaiting_approval' } });
        await prismaKnowledge.evolutionAudit.create({ data: { action: 'gate3_awaiting_approval', candidateId, scope: candidate.scope, reason: result.reason } });
        return { pass: true, reason: '等待管理员审批: ' + result.reason };
      } else {
        await prismaKnowledge.evolutionCandidate.update({ where: { id: candidateId }, data: { status: 'canary', promotedAt: new Date(), canaryPercent: 5 } });
        await prismaKnowledge.evolutionAudit.create({ data: { action: 'gate3_canary', candidateId, scope: candidate.scope, reason: result.reason } });
        await incrementBudgetCounter('promoteCount');
        return { pass: true, reason: 'Canary 发布 5%: ' + result.reason };
      }
    } else {
      await prismaKnowledge.evolutionCandidate.update({ where: { id: candidateId }, data: { status: 'rejected', rejectedAt: new Date(), rejectReason: result.reason } });
      await incrementBudgetCounter('rejectCount');
      return { pass: false, reason: result.reason };
    }
  } catch (err: any) {
    return { pass: false, reason: '评估异常: ' + (err.message || '') };
  }
}

// ========== Admin Actions ==========

export async function adminApproveCandidate(candidateId: string, adminId: string): Promise<boolean> {
  const candidate = await prismaKnowledge.evolutionCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.status !== 'awaiting_approval') return false;
  await prismaKnowledge.evolutionCandidate.update({ where: { id: candidateId }, data: { status: 'canary', promotedAt: new Date(), canaryPercent: 5 } });
  await prismaKnowledge.evolutionAudit.create({ data: { action: 'admin_approve', candidateId, adminId, scope: candidate.scope, reason: '管理员批准' } });
  await incrementBudgetCounter('promoteCount');
  return true;
}

export async function adminRejectCandidate(candidateId: string, adminId: string, reason: string): Promise<boolean> {
  const candidate = await prismaKnowledge.evolutionCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) return false;
  await prismaKnowledge.evolutionCandidate.update({ where: { id: candidateId }, data: { status: 'rejected', rejectedAt: new Date(), rejectReason: reason } });
  await prismaKnowledge.evolutionAudit.create({ data: { action: 'admin_reject', candidateId, adminId, scope: candidate.scope, reason } });
  await incrementBudgetCounter('rejectCount');
  return true;
}

export async function promoteCanaryToFull(candidateId: string): Promise<boolean> {
  const candidate = await prismaKnowledge.evolutionCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.status !== 'canary') return false;
  await prismaKnowledge.evolutionCandidate.update({ where: { id: candidateId }, data: { status: 'promoted', canaryPercent: 100 } });
  await prismaKnowledge.evolutionAudit.create({ data: { action: 'canary_to_full', candidateId, scope: candidate.scope, reason: 'Canary 无回归，全量发布' } });
  return true;
}

// ========== Enhanced Retrieval ==========

export async function getRegionInsights(region: string): Promise<string[]> {
  const insights = await prismaKnowledge.regionInsight.findMany({
    where: { region, isActive: true, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    take: 3,
    orderBy: { confidence: 'desc' },
  });
  return insights.map(i => i.insight);
}

// ========== Main Pipeline ==========

export async function runEvolutionPipeline(userId: string, conversationId: string, region?: string): Promise<void> {
  try {
    const budget = await checkUserBudget(userId);
    if (!budget.allowed) return;

    // Messages from the Conversation DB
    const messages = await prismaConversation.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    if (messages.length < 2) return;

    const reversed = messages.reverse();
    const signals = await detectSignals(reversed, userId, region);
    if (signals.length === 0) return;

    await consumeUserBudget(userId);
    await incrementBudgetCounter('signalCount');

    for (const signal of signals) {
      // Signal → Knowledge DB
      const dbSignal = await prismaKnowledge.evolutionSignal.create({
        data: { userId, conversationId, region, signalType: signal.type, severity: signal.severity, detail: signal.detail, messageId: signal.messageId },
      });

      const highValue = ['user_correction', 'repeated_failure', 'retrieval_miss'];
      let worthEvolving = true;

      if (highValue.includes(signal.type) && signal.severity !== 'low') {
        const attr = await agnesAttribute(signal);
        worthEvolving = attr.worthEvolving;
        await prismaKnowledge.evolutionSignal.update({ where: { id: dbSignal.id }, data: { attributed: true, worthEvolving: attr.worthEvolving, attribution: attr as any } });
        if (!worthEvolving) continue;
      }

      const built = await buildCandidate(signal, userId, region);

      // Candidate → Knowledge DB
      const candidate = await prismaKnowledge.evolutionCandidate.create({
        data: {
          scope: built.scope, changeType: built.changeType, targetType: built.targetType,
          hypothesis: built.hypothesis, content: built.content, evidenceRefs: JSON.stringify(built.evidenceRefs),
          region: built.region, userId: built.userId, blastRadius: built.blastRadius,
          gateLevel: built.gateLevel, confidence: built.confidence, status: 'pending',
        },
      });

      await incrementBudgetCounter('candidateCount');

      switch (built.gateLevel) {
        case 1: await gate1Promote(candidate.id); break;
        case 2: await gate2Evaluate(candidate.id); break;
        case 3: await gate3Evaluate(candidate.id); break;
      }
    }
  } catch (err) {
    console.error('Evolution pipeline error:', err);
  }
}

async function checkUserBudget(userId: string): Promise<{ allowed: boolean; used: number; limit: number }> {
  try {
    const user = await prismaKnowledge.evolutionSignal.count({
      where: { userId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
    return { allowed: user < 50, used: user, limit: 50 };
  } catch {
    return { allowed: true, used: 0, limit: 50 };
  }
}

export async function consumeUserBudget(userId: string): Promise<void> {
  // Counted via signal creation, no separate counter needed
}

export async function checkSystemPool(tokensNeeded: number): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let budget = await prismaKnowledge.evolutionBudget.findUnique({ where: { date: today } });
    if (!budget) {
      budget = await prismaKnowledge.evolutionBudget.create({ data: { date: today } });
    }
    const remaining = budget.systemPoolTotal - budget.systemPoolUsed;
    return { allowed: remaining >= tokensNeeded, remaining };
  } catch {
    return { allowed: true, remaining: 10000 };
  }
}

export async function consumeSystemPool(tokens: number): Promise<void> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await prismaKnowledge.evolutionBudget.upsert({
      where: { date: today },
      create: { date: today, systemPoolUsed: tokens },
      update: { systemPoolUsed: { increment: tokens } },
    });
  } catch {}
}

export async function incrementBudgetCounter(field: 'signalCount' | 'candidateCount' | 'promoteCount' | 'rejectCount'): Promise<void> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await prismaKnowledge.evolutionBudget.upsert({
      where: { date: today },
      create: { date: today, [field]: 1 },
      update: { [field]: { increment: 1 } },
    });
  } catch {}
}