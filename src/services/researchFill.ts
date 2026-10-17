// ================================================================
// Research Fill — 自补缺最后一环：研究任务完成后，把收集到的证据
// 真正写成知识库事实：
//   ResearchRecord(PENDING) → 交叉验证/冲突检测 → 组织(整理器) →
//   KnowledgeFact + KnowledgeFactEvidence 落库 → 刷新状态戳记 →
//   向量索引 → 盲点 RESOLVED → 达阈值时自动触发组织任务(自整理)
// 由 researchExecutor 在 Phase 3 收集完成后调用。
// ================================================================

import { prismaKnowledge, prismaUser } from './db';
import { crossValidate } from './crossValidation';
import { detectConflicts } from './conflictDetection';
import { organizeKnowledge } from './knowledgeOrganizer';
import { stampNewFact } from './knowledgeLifecycle/factTimeStamper';
import { indexKnowledgeChunk } from './vectorSearch';
import { checkOrganizationTrigger, createOrganizationJob } from './knowledgeOrg/orgRuntime';
import type { CollectedEvidence } from './evidenceCollector';

export interface ResearchFillResult {
  factsWritten: number;
  factsSkipped: number;
  blindSpotsResolved: number;
  orgTriggered: boolean;
  summary: string;
}

function normClaim(claim: string): string {
  return String(claim ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function firstSentence(text: string, limit = 300): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?[.!?。？])/);
  return (m ? m[1] : t).slice(0, limit);
}

function toDate(v: any): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function fillFromResearch(opts: {
  jobId: string;
  recordId: string;
  objectId: string;
  variantId: string | null;
  plan: any;
  evidence: CollectedEvidence[];
}): Promise<ResearchFillResult> {
  const { jobId, recordId, objectId, variantId, plan } = opts;

  // 1. 重新读取已持久化的 Evidence（组织器需要真实 id 来建事实 ↔ 证据关联）
  const rows = await prismaKnowledge.evidence.findMany({
    where: { researchRecordId: recordId },
    include: { source: true },
  });
  const evForOrganize = rows.map((r) => {
    let metadata: Record<string, any> = {};
    try { metadata = JSON.parse(r.metadataJson || '{}'); } catch {}
    return { id: r.id, domain: r.source?.domain ?? '', evidenceType: r.evidenceType, content: r.content, metadata, observedAt: r.observedAt };
  });

  // 2. 交叉验证 + 冲突检测（纯函数，无额外 LLM 调用）
  const claims = rows.map((r) => ({
    claim: firstSentence(r.content),
    value: String(r.content ?? '').slice(0, 2000),
    source: r.source?.canonicalUrl ?? '',
  }));
  const validation = crossValidate(opts.evidence, claims);
  const conflicts = detectConflicts(
    rows.map((r, i) => ({ id: r.id, claim: claims[i].claim, value: claims[i].value, confidence: 0.5 })),
  );

  // 3. 组织（Gemini 可用时语义归一，不可用时确定性回退成组）
  const organized = await organizeKnowledge(recordId, evForOrganize, validation, conflicts);

  // 4. 写事实：跳过该对象上已有 ACTIVE+同义 claim，其余建 KnowledgeFact + 证据关联
  const existing = await prismaKnowledge.knowledgeFact.findMany({
    where: { objectId, lifecycleStatus: 'ACTIVE' },
    select: { claim: true },
    take: 500,
  });
  const existingClaims = new Set(existing.map((f) => normClaim(f.claim)));
  const validEvidenceIds = new Set(rows.map((r) => r.id));

  let factsWritten = 0;
  let factsSkipped = 0;
  for (const fact of organized.facts) {
    const key = normClaim(fact.claim);
    if (!key || existingClaims.has(key)) { factsSkipped++; continue; }

    const created = await prismaKnowledge.knowledgeFact.create({
      data: {
        objectId,
        variantId: (fact.variantId as string | undefined) ?? variantId,
        claim: fact.claim,
        claimType: fact.claimType,
        confidence: fact.confidence,
        observedAt: toDate(fact.observedAt),
        validFrom: toDate(fact.validFrom),
        validTo: toDate(fact.validTo),
      },
    });
    existingClaims.add(key);

    const links = (fact.evidenceIds ?? [])
      .filter((eid) => validEvidenceIds.has(eid))
      .map((evidenceId) => ({ factId: created.id, evidenceId }));
    if (links.length > 0) {
      await prismaKnowledge.knowledgeFactEvidence.createMany({ data: links });
    }

    await stampNewFact({
      factId: created.id,
      lifecycleStatus: created.lifecycleStatus,
      verificationStatus: created.verificationStatus,
      initialIntervalMonths: 1,
    });
    await indexKnowledgeChunk(created.id, fact.claim).catch(() => undefined);
    factsWritten++;
  }

  // 5. 研究记录完结（含组织摘要、冲突、未决项）
  const gapsText = claims.length === 0
    ? 'no usable evidence was collected'
    : `${factsWritten} fact(s) written, ${factsSkipped} duplicate(s) skipped`;
  await prismaKnowledge.researchRecord.update({
    where: { id: recordId },
    data: {
      status: 'COMPLETED',
      summary: [
        organized.summary,
        gapsText,
        `${validation.validated.length} claim(s) cross-validated, ${validation.conflicted.length + conflicts.length} conflict(s), ${validation.insufficient.length} claim(s) with insufficient sourcing.`,
      ].join(' '),
      conflictsJson: JSON.stringify([...conflicts, ...(validation.conflicted ?? [])]),
      unknownsJson: JSON.stringify([...(organized.unknowns ?? []), ...(validation.insufficient ?? [])]),
      completedAt: new Date(),
    },
  });

  // 6. 关闭该对象的开放盲点（自补缺闭环）
  const blindSpotsResolved = factsWritten > 0
    ? (await prismaUser.knowledgeBlindSpot.updateMany({
        where: { objectId, variantId: variantId ?? null, status: { in: ['OPEN', 'RESEARCHING'] } },
        data: {
          status: 'RESOLVED',
          researchJobId: jobId,
          resolvedAt: new Date(),
          resolvedSummary: `研究任务 ${jobId} 写入 ${factsWritten} 条事实`,
        },
      })).count
    : 0;

  // 7. 自整理触发：达阈值时自动登记 OrganizationJob（worker 池会领走执行）
  let orgTriggered = false;
  try {
    const t = await checkOrganizationTrigger(objectId);
    if (t.needed) {
      await createOrganizationJob('object', objectId, `AUTO_RESEARCH_COMPLETION: ${t.reason}`, objectId, 4);
      orgTriggered = true;
    }
  } catch (err) {
    console.warn('[ResearchFill] auto-organize trigger failed:', (err as any)?.message);
  }

  return { factsWritten, factsSkipped, blindSpotsResolved, orgTriggered, summary: organized.summary };
}
