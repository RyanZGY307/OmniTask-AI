// ================================================================
// Blind Spot Detector — detect coverage gaps, persist to System DB
// ================================================================

import { prismaUser } from './db';
import type { CoverageReport, DimensionStatus } from './coverageAnalysis';

const GAP_TYPE_BY_STATUS: Record<Exclude<DimensionStatus, 'COMPLETE'>, string> = {
  MISSING: 'MISSING',
  CONFLICTED: 'CONFLICT',
  REALTIME_REQUIRED: 'REALTIME_REQUIRED',
  PARTIAL: 'INSUFFICIENT_EVIDENCE',
};

const PRIORITY_BY_GAP_TYPE: Record<string, number> = {
  CONFLICT: 2,
  MISSING: 3,
  REALTIME_REQUIRED: 4,
  INSUFFICIENT_EVIDENCE: 6,
};

function describeGap(dim: string, status: DimensionStatus): string {
  switch (status) {
    case 'MISSING':
      return `required dimension "${dim}" has no recorded facts`;
    case 'CONFLICTED':
      return `dimension "${dim}" has conflicting facts that need reconciliation`;
    case 'REALTIME_REQUIRED':
      return `dimension "${dim}" depends on live/real-time data`;
    case 'PARTIAL':
      return `dimension "${dim}" is partially covered: stale, low-confidence facts or missing sources`;
    default:
      return `dimension "${dim}" coverage problem`;
  }
}

export async function checkExistingBlindSpot(
  objectId: string,
  gapType: string,
  variantId?: string,
): Promise<any | null> {
  return prismaUser.knowledgeBlindSpot.findFirst({
    where: {
      objectId,
      gapType,
      variantId: variantId || null,
      status: 'OPEN',
    },
  });
}

export async function createBlindSpot(
  objectId: string,
  variantId: string | null,
  gapType: string,
  description: string,
  priority?: number,
): Promise<string> {
  const created = await prismaUser.knowledgeBlindSpot.create({
    data: {
      objectId,
      variantId,
      gapType,
      gapDescription: description,
      priority: priority ?? 5,
    },
  });
  return created.id;
}

export async function detectBlindSpots(
  objectId: string,
  coverage: CoverageReport,
  variantId?: string,
): Promise<string[]> {
  const createdIds: string[] = [];
  for (const [dim, status] of Object.entries(coverage?.dimensions ?? {})) {
    if (status === 'COMPLETE') continue;

    const gapType = GAP_TYPE_BY_STATUS[status];
    const description = describeGap(dim, status);
    const priority = PRIORITY_BY_GAP_TYPE[gapType] ?? 5;

    const existing = await checkExistingBlindSpot(objectId, gapType, variantId);
    if (existing) continue;

    const id = await createBlindSpot(objectId, variantId || null, gapType, description, priority);
    createdIds.push(id);
  }
  return createdIds;
}
