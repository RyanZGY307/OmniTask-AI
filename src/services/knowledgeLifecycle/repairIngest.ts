// ================================================================
// Repair Ingest — Research Job completion hook for the self-repair
// loop (R3). When a research job spawned by a SelfRepairTask finishes,
// cross-validate the evidence, write through FactWriter, and either
// RESOLVE or escalate (TERMINATE) based on the closed-loop cap.
// This is the "回流" step that closes the loop.
// ================================================================

import { prismaUser } from '../db';
import { prismaKnowledge } from '../db';
import { crossValidate, type ClaimInput } from '../crossValidation';
import { writeFactValue } from './factWriter';

// Max repair iterations per (rootTask, fact) before terminating the loop.
const MAX_REPAIR_ITERATIONS = 3;

export interface IngestResult {
  taskId: string;
  terminal: 'RESOLVED' | 'CANNOT_VERIFY' | 'TERMINATED';
  factChanged: boolean;
}

// Called when a ResearchJob with a rootTaskId (SelfRepairTask) completes.
export async function ingestRepairEvidence(researchJobId: string): Promise<IngestResult | null> {
  const job = await prismaUser.researchJob.findUnique({ where: { id: researchJobId } });
  if (!job || !job.rootTaskId) return null;

  const task = await prismaUser.selfRepairTask.findUnique({ where: { id: job.rootTaskId } });
  if (!task) return null;

  const fact = await prismaKnowledge.knowledgeFact.findUnique({
    where: { id: task.targetFactId },
    include: { evidence: { include: { evidence: { include: { source: true } } } } },
  });
  if (!fact) {
    await prismaUser.selfRepairTask.update({
      where: { id: task.id },
      data: { status: 'CANNOT_VERIFY', terminateReason: 'target fact no longer exists' },
    });
    return { taskId: task.id, terminal: 'CANNOT_VERIFY', factChanged: false };
  }

  // Cross-validate the fact against its current evidence set: one claim,
  // one entry per independent source value.
  const claims: ClaimInput[] = fact.evidence.map((fe) => ({
    claim: fact.claim,
    value: fe.evidence.content ?? '',
    source: fe.evidence.source?.canonicalUrl ?? '',
  }));

  const report = crossValidate(
    fact.evidence.map((fe) => ({
      url: fe.evidence.source?.canonicalUrl ?? '',
      domain: fe.evidence.source?.domain ?? '',
      observedAt: fe.evidence.observedAt ?? new Date(),
    })) as any,
    claims,
  );

  const isConflict = report.conflicted.length > 0;
  const isVerified = !isConflict && report.insufficient.length === 0 && claims.length >= 2;

  // Closed-loop cap: if we've hit the iteration limit and still cannot verify,
  // terminate instead of spinning forever (R3.4).
  if (!isVerified && !isConflict && task.iteration >= MAX_REPAIR_ITERATIONS) {
    await prismaUser.selfRepairTask.update({
      where: { id: task.id },
      data: { status: 'TERMINATED', terminateReason: `reached ${MAX_REPAIR_ITERATIONS} repair iterations without agreement` },
    });
    return { taskId: task.id, terminal: 'TERMINATED', factChanged: false };
  }

  if (isVerified) {
    const evidenceIds = fact.evidence.map((fe) => fe.evidence.id);
    const sourceIds = fact.evidence.map((fe) => fe.evidence.source?.canonicalUrl ?? '').filter(Boolean);
    await writeFactValue({
      factId: fact.id,
      newValue: fact.claim, // value unchanged; re-verification only bumps status + audit
      changeType: 'UNCHANGED',
      evidenceIds,
      sourceIds,
      researchJobId: job.id,
      refreshTaskId: null,
    });
    await prismaUser.selfRepairTask.update({
      where: { id: task.id },
      data: {
        status: 'RESOLVED',
        resultJson: JSON.stringify({
          verified: true,
          evidenceCount: fact.evidence.length,
          validated: report.validated,
        }),
      },
    });
    return { taskId: task.id, terminal: 'RESOLVED', factChanged: false };
  }

  if (isConflict) {
    // conflicting evidence: mark the fact CONFLICTED (original value preserved),
    // escalate the repair task for the next iteration.
    await writeFactValue({
      factId: fact.id,
      newValue: null,
      changeType: 'CONFLICT',
      researchJobId: job.id,
      refreshTaskId: null,
    });
    await prismaUser.selfRepairTask.update({
      where: { id: task.id },
      data: {
        status: task.iteration >= MAX_REPAIR_ITERATIONS ? 'TERMINATED' : 'OPEN',
        terminateReason: task.iteration >= MAX_REPAIR_ITERATIONS ? 'conflict persists after max iterations' : null,
        iteration: task.iteration + 1,
        resultJson: JSON.stringify({
          conflicted: report.conflicted.map((g) => ({ claim: g.claim, values: g.values.length })),
        }),
      },
    });
    return { taskId: task.id, terminal: task.iteration >= MAX_REPAIR_ITERATIONS ? 'TERMINATED' : 'CANNOT_VERIFY', factChanged: true };
  }

  // Insufficient evidence: don't mutate the fact, mark the task and shorten
  // the verification cycle so the next refresh re-checks sooner (R5.4).
  await prismaKnowledge.factRefreshState.updateMany({
    where: { factId: fact.id },
    data: { refreshIntervalMonths: 1, priority: 2, lastRefreshStatus: 'CANNOT_VERIFY' },
  });
  await prismaUser.selfRepairTask.update({
    where: { id: task.id },
    data: {
      status: 'CANNOT_VERIFY',
      resultJson: JSON.stringify({ insufficient: report.insufficient, evidenceCount: claims.length }),
    },
  });
  return { taskId: task.id, terminal: 'CANNOT_VERIFY', factChanged: false };
}
