// ================================================================
// Accuracy Gate — R5 five-state verdict for facts touched by an org job.
// Two-stage: rule layer (zero-model, cheap prefilter) then AI verdict for
// the gray items. Non-PASS verdicts open a SelfRepairTask (R3).
// Only scans new/changed facts in the current org job — not the whole DB.
// ================================================================

import { prismaKnowledge } from '../db';
import { prismaUser } from '../db';
import { callAgnesForText, isAgnesAvailable } from '../knowledgeOrganizerGemini';

export type GateVerdict =
  | 'PASS'
  | 'NEEDS_VERIFICATION'
  | 'CONFLICT'
  | 'SUSPECTED_INACCURATE'
  | 'OUTDATED';

export interface GateInput {
  fact: {
    id: string;
    claim: string;
    claimType: string;
    verificationStatus: string;
    confidence: number;
    validTo?: Date | null;
    createdAt: Date;
  };
  evidence: Array<{ summary?: string; sourceType?: string; isOfficial?: boolean; agreement?: string; fetchedAt?: Date }>;
}

export interface GateResult {
  verdict: GateVerdict;
  confidence: number;
  evidence: string; // rule/AI summary
  isRule: boolean;  // true when decided by the cheap rule layer
}

// ---- Rule layer (zero-model): authoritative / independence / conflict / freshness ----

function ruleVerdict(input: GateInput): { verdict: GateVerdict; confidence: number; reason: string } {
  const { fact, evidence } = input;
  const now = Date.now();

  // Explicit conflict across evidence -> CONFLICT
  const hasConflict = evidence.some((e) => e.agreement === 'CONFLICT');
  if (hasConflict) return { verdict: 'CONFLICT', confidence: 0.7, reason: 'conflicting evidence agreement' };

  // official source gone + fact has validTo in the past -> OUTDATED
  const pastValidTo = fact.validTo && new Date(fact.validTo).getTime() < now;
  const officialGone = evidence.some((e) => e.isOfficial === false && e.sourceType === 'OFFICIAL');
  if (pastValidTo || officialGone) return { verdict: 'OUTDATED', confidence: 0.6, reason: 'validTo past or official source gone' };

  // single-source fact at low confidence -> NEEDS_VERIFICATION
  const independentSources = new Set(evidence.map((e) => e.sourceType ?? 'UNKNOWN')).size;
  if (independentSources <= 1 && fact.confidence < 0.5) {
    return { verdict: 'NEEDS_VERIFICATION', confidence: 0.4, reason: 'single-source low-confidence fact' };
  }

  // all evidence agrees + verified -> PASS
  const allAgree = evidence.length > 0 && evidence.every((e) => e.agreement === 'AGREE' || e.agreement === undefined);
  if (allAgree && fact.verificationStatus === 'VERIFIED') {
    return { verdict: 'PASS', confidence: 0.9, reason: 'verified with agreeing evidence' };
  }

  // gray: not clearly rule-decidable -> return null so AI stage handles it
  return { verdict: 'NEEDS_VERIFICATION', confidence: 0.3, reason: 'gray fact, route to AI' };
}

// ---- AI stage: only for gray facts; Gemini unavailable -> conservative NEEDS_VERIFICATION ----

async function aiVerdict(input: GateInput): Promise<GateResult> {
  if (!isAgnesAvailable()) {
    const r = ruleVerdict(input);
    return { verdict: r.verdict === 'PASS' ? 'PASS' : 'NEEDS_VERIFICATION', confidence: r.confidence, evidence: 'gemini-unavailable, conservative ' + r.reason, isRule: true };
  }
  const prompt = [
    'You are a fact-accuracy gate. Given one fact and its evidence, return exactly one JSON object:',
    '{"verdict":"PASS|NEEDS_VERIFICATION|CONFLICT|SUSPECTED_INACCURATE|OUTDATED","confidence":0.0,"reason":"<short>"}',
    'Fact:', JSON.stringify({ claim: input.fact.claim, claimType: input.fact.claimType, verificationStatus: input.fact.verificationStatus, confidence: input.fact.confidence }),
    'Evidence:', JSON.stringify(input.evidence.slice(0, 8).map((e) => ({ summary: e.summary?.slice(0, 200), sourceType: e.sourceType, isOfficial: e.isOfficial }))),
  ].join('\n');

  const VERDICTS: GateVerdict[] = ['PASS', 'NEEDS_VERIFICATION', 'CONFLICT', 'SUSPECTED_INACCURATE', 'OUTDATED'];
  try {
    const raw = await callAgnesForText(prompt, { temperature: 0.1, maxTokens: 512 });
    const parsed = parseGateJson(raw);
    if (parsed && VERDICTS.includes(parsed.verdict as GateVerdict)) {
      return {
        verdict: parsed.verdict as GateVerdict,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        evidence: parsed.reason ?? 'ai verdict',
        isRule: false,
      };
    }
  } catch {
    // AI unavailable / malformed -> fall through to conservative rule result
  }
  const r = ruleVerdict(input);
  return { verdict: r.verdict === 'PASS' ? 'PASS' : 'NEEDS_VERIFICATION', confidence: r.confidence, evidence: 'ai-degraded ' + r.reason, isRule: true };
}

function parseGateJson(raw: string): { verdict: string; confidence?: number; reason?: string } | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    return { verdict: obj.verdict, confidence: obj.confidence, reason: obj.reason };
  } catch {
    return null;
  }
}

// Evaluate one fact through the gate. Rule layer first; gray -> AI.
export async function runAccuracyGate(input: GateInput): Promise<GateResult> {
  const r = ruleVerdict(input);
  // clear rule verdicts (PASS / CONFLICT / OUTDATED with reason) skip AI
  if (r.reason.startsWith('conflicting') || r.reason.startsWith('validTo') || r.reason.startsWith('verified')) {
    return { verdict: r.verdict, confidence: r.confidence, evidence: r.reason, isRule: true };
  }
  return aiVerdict(input);
}

// Record a gate decision + open a SelfRepairTask for non-PASS verdicts.
export async function recordGateDecision(input: {
  factId: string;
  result: GateResult;
  rootTaskId: string; // originating org/repair root
  triggerType: string; // ACCURACY_GATE | REFRESH_CONFLICT | SOURCE_GONE | BLIND_SPOT
  refreshCycle?: string | null;
}): Promise<{ decisionId: string; repairTaskId: string | null }> {
  const decision = await prismaKnowledge.accuracyGateDecision.create({
    data: {
      factId: input.factId,
      verdict: input.result.verdict,
      confidence: input.result.confidence,
      evidence: JSON.stringify({ ai: !input.result.isRule, note: input.result.evidence, gateAt: new Date().toISOString() }),
    },
  });

  let repairTaskId: string | null = null;
  if (input.result.verdict !== 'PASS') {
    // R3.2 de-duplication: DB-level unique guard, not application convention.
    // (rootTaskId, targetFactId, refreshCycle, triggerType) is the idempotency
    // key — a second attempt for the same tuple is a no-op, not a new task.
    const key = {
      rootTaskId: input.rootTaskId,
      targetFactId: input.factId,
      refreshCycle: input.refreshCycle ?? null,
      triggerType: input.triggerType,
    } as any;
    let task = await prismaUser.selfRepairTask.findUnique({ where: key }).catch(() => null);
    if (!task) {
      task = await prismaUser.selfRepairTask.create({
        data: {
          rootTaskId: input.rootTaskId,
          triggerType: input.triggerType,
          targetFactId: input.factId,
          reason: input.result.evidence,
          iteration: 1,
          refreshCycle: input.refreshCycle ?? null,
        },
      }).catch(() => prismaUser.selfRepairTask.findUnique({ where: key }));
    }
    repairTaskId = task?.id ?? null;
    if (repairTaskId) {
      await prismaKnowledge.accuracyGateDecision.update({
        where: { id: decision.id },
        data: { repairTaskId },
      });
    }
  }
  return { decisionId: decision.id, repairTaskId };
}

// Dispatch repair research for an open SelfRepairTask (creates a ResearchJob with lineage).
export async function dispatchRepairResearch(taskId: string): Promise<string | null> {
  const task = await prismaUser.selfRepairTask.findUnique({ where: { id: taskId } });
  if (!task || task.status !== 'OPEN') return null;
  const job = await prismaUser.researchJob.create({
    data: {
      objectId: task.targetFactId,
      jobType: 'ENRICHMENT',
      status: 'QUEUED',
      priority: task.triggerType === 'REFRESH_CONFLICT' ? 2 : 3,
      planJson: JSON.stringify({
        repairTaskId: task.id,
        targetFactId: task.targetFactId,
        reason: task.reason,
        triggerType: task.triggerType,
        rootTaskId: task.rootTaskId,
        queries: [],
      }),
      rootTaskId: task.id,
      targetFactId: task.targetFactId,
      iteration: task.iteration,
    },
  });
  await prismaUser.selfRepairTask.update({
    where: { id: task.id },
    data: { status: 'RESEARCHING', researchJobId: job.id },
  });
  return job.id;
}
