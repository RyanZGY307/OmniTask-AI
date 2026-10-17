// ================================================================
// Research Record — build structured research records
// ================================================================

import { prismaKnowledge } from './db';
import type { CollectedEvidence } from './evidenceCollector';
import type { ValidationReport } from './crossValidation';
import type { Conflict } from './conflictDetection';

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function deriveScope(plan: any): string {
  if (plan && typeof plan === 'object') {
    if (typeof plan.researchScope === 'string' && plan.researchScope) return plan.researchScope;
    if (typeof plan.gapDescription === 'string' && plan.gapDescription) return plan.gapDescription;
    if (Array.isArray(plan.objectives) && plan.objectives[0]) return String(plan.objectives[0]);
    if (Array.isArray(plan.dimensions) && plan.dimensions.length > 0) {
      return `dimensions: ${plan.dimensions.join(', ')}`;
    }
  }
  return 'general knowledge research';
}

function buildSummary(
  evidence: CollectedEvidence[],
  validation: ValidationReport,
  conflicts: Conflict[],
): string {
  const srcCount = evidence?.length ?? 0;
  const validated = validation?.validated?.length ?? 0;
  const conflicted = conflicts?.length ?? validation?.conflicted?.length ?? 0;
  const unknowns = validation?.insufficient?.length ?? 0;
  return [
    `Collected ${srcCount} evidence item(s).`,
    `${validated} claim(s) cross-validated, ${conflicted} conflict(s), ${unknowns} claim(s) with insufficient sourcing.`,
  ].join(' ');
}

export async function buildResearchRecord(
  jobId: string,
  objectId: string,
  variantId: string | null,
  plan: any,
  evidence: CollectedEvidence[],
  validation: ValidationReport,
  conflicts: Conflict[],
): Promise<string> {
  const record = await prismaKnowledge.researchRecord.create({
    data: {
      objectId,
      variantId: variantId ?? null,
      researchScope: deriveScope(plan),
      researchPlanJson: JSON.stringify(plan ?? {}),
      status: 'COMPLETED',
      summary: buildSummary(evidence, validation, conflicts),
      conflictsJson: JSON.stringify(conflicts ?? []),
      unknownsJson: JSON.stringify(validation?.insufficient ?? []),
      retrievedAt: new Date(),
      completedAt: new Date(),
    },
  });

  console.log(
    `[ResearchRecord] ${record.id} created for object ${objectId} (variant ${variantId ?? 'n/a'}), job ${jobId}`,
  );
  return record.id;
}

export async function getResearchRecord(recordId: string): Promise<any | null> {
  const record = await prismaKnowledge.researchRecord.findUnique({
    where: { id: recordId },
    include: { object: true, variant: true },
  });
  if (!record) return null;

  return {
    ...record,
    researchPlan: safeParse<any>(record.researchPlanJson, null),
    conflicts: safeParse<Conflict[]>(record.conflictsJson, []),
    unknowns: safeParse<string[]>(record.unknownsJson, []),
  };
}
