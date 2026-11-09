// ================================================================
// ExperienceLibrary — 历史经验库（复用 EvolutionCandidate 表 + EvaluationReport）。
// 只读查询 + 追加记录；不做覆盖式更新。
// ================================================================

import { prismaKnowledge } from '../db';

export interface ExperienceRow {
  candidateId: string;
  assetKey: string;
  status: string;
  decision: string;
  quality?: number;
  createdAt: Date;
}

/** 查询同资产历史经验，用于证据装配与「重复候选过滤」。 */
export async function listExperience(assetKey: string, limit = 10): Promise<ExperienceRow[]> {
  const rows = await prismaKnowledge.evolutionCandidate.findMany({
    where: { targetId: assetKey },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 20),
    select: { id: true, targetId: true, status: true, evaluationId: true, createdAt: true },
  });
  const evalIds = rows.map((r) => r.evaluationId).filter((x): x is string => !!x);
  const evals = evalIds.length
    ? await prismaKnowledge.evaluationReport.findMany({ where: { id: { in: evalIds } }, select: { id: true, decision: true, qualityScore: true } })
    : [];
  const evalMap = new Map(evals.map((e) => [e.id, e]));
  return rows.map((r) => {
    const ev = r.evaluationId ? evalMap.get(r.evaluationId) : undefined;
    return {
      candidateId: r.id,
      assetKey: r.targetId ?? '',
      status: r.status,
      decision: ev?.decision ?? 'none',
      quality: ev?.qualityScore ?? undefined,
      createdAt: r.createdAt,
    };
  });
}

/** 记录一条经验（发布或回滚后调用），写入审计即可查询的痕迹。 */
export async function recordExperience(input: {
  candidateId: string;
  assetKey: string;
  outcome: 'released' | 'rolled_back' | 'rejected' | 'failed';
  metrics?: Record<string, unknown>;
}): Promise<void> {
  const existing = await prismaKnowledge.evolutionAudit.findFirst({
    where: { candidateId: input.candidateId, action: `exp_${input.outcome}` },
  });
  if (existing) return;
  await prismaKnowledge.evolutionAudit.create({
    data: {
      action: `exp_${input.outcome}`,
      candidateId: input.candidateId,
      scope: input.assetKey,
      reason: `experience:${input.outcome}`,
      metadata: input.metrics ? JSON.stringify(input.metrics) : null,
    },
  });
}

/** 近期该资产是否已有同类失败候选（抑制振荡式反复提议）。 */
export async function recentFailureCount(assetKey: string, windowHours = 168): Promise<number> {
  const since = new Date(Date.now() - windowHours * 3600_000);
  return prismaKnowledge.evolutionAudit.count({
    where: {
      scope: assetKey,
      action: { in: ['exp_rolled_back', 'exp_rejected', 'exp_failed'] },
      createdAt: { gte: since },
    },
  });
}
