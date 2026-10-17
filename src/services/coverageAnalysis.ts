// ================================================================
// Coverage Analysis — pure, DB-free per-dimension coverage check
// ================================================================

export type DimensionStatus = 'COMPLETE' | 'PARTIAL' | 'MISSING' | 'REALTIME_REQUIRED' | 'CONFLICTED';
export type OverallStatus = 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT';

export interface CoverageReport {
  dimensions: Record<string, DimensionStatus>;
  overall: OverallStatus;
  gaps: string[];
  conflictCount: number;
  freshnessScore: number;
  sourceQuality: number;
}

const REALTIME_DIMENSION_PATTERN = /real.?time|live|price|stock|availability|exchange|currency|weather|traffic|latest|current|inventory|quote/i;
const FRESH_MS = 14 * 24 * 60 * 60 * 1000;
const STALE_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_CONFIDENCE = 0.4;

function isRealtimeDimension(dim: string): boolean {
  return REALTIME_DIMENSION_PATTERN.test(dim);
}

function factTimestamp(f: any): number | null {
  if (!f) return null;
  const keys = ['observedAt', 'updatedAt', 'createdAt', 'retrievedAt', 'recordedAt'];
  for (const key of keys) {
    const raw = f[key];
    if (!raw) continue;
    const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

function factDimension(f: any): string {
  if (!f) return '';
  return String(f.dimension ?? f.dimensionKey ?? f.claimType ?? '').toLowerCase();
}

function factConfidence(f: any): number {
  const c = f?.confidence;
  return typeof c === 'number' && !Number.isNaN(c) ? c : 0.5;
}

function isConflictFact(f: any): boolean {
  if (!f) return false;
  return (
    f.verificationStatus === 'CONFLICTED' ||
    f.status === 'CONFLICTED' ||
    f.conflicting === true ||
    f.conflictCount > 0
  );
}

// 1 = fresh, 0.5 = aging, 0 = stale or unknown
function factFreshness(f: any, now: number): number {
  const ts = factTimestamp(f);
  if (ts === null) return 0;
  const age = now - ts;
  if (age <= 0 || age <= FRESH_MS) return 1;
  if (age <= STALE_MS) return 0.5;
  return 0;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function analyzeCoverage(
  object: any,
  facts: any[],
  sources: any[],
  requiredDimensions: string[],
): CoverageReport {
  const now = Date.now();
  const safeFacts = Array.isArray(facts) ? facts : [];
  const safeSources = Array.isArray(sources) ? sources : [];
  const dims = Array.isArray(requiredDimensions) ? requiredDimensions : [];

  const dimensions: Record<string, DimensionStatus> = {};
  const gaps: string[] = [];

  let conflictCount = 0;
  for (const f of safeFacts) {
    if (isConflictFact(f)) conflictCount += 1;
  }

  for (const dimRaw of dims) {
    const dim = String(dimRaw ?? '').toLowerCase();
    if (!dim) continue;

    const dimFacts = safeFacts.filter((f) => factDimension(f) === dim);
    const realtime = isRealtimeDimension(dim);

    if (dimFacts.length === 0) {
      dimensions[dim] = realtime ? 'REALTIME_REQUIRED' : 'MISSING';
      gaps.push(
        realtime
          ? `dimension "${dim}" requires live/real-time data (no recorded facts)`
          : `dimension "${dim}" has no recorded facts`,
      );
      continue;
    }

    const conflicts = dimFacts.filter(isConflictFact);
    if (conflicts.length > 0) {
      dimensions[dim] = 'CONFLICTED';
      gaps.push(`dimension "${dim}" has ${conflicts.length} conflicting fact(s)`);
      continue;
    }

    const hasSources = safeSources.length > 0;
    const freshness = dimFacts.reduce((sum, f) => sum + factFreshness(f, now), 0) / dimFacts.length;
    const confidence = dimFacts.reduce((sum, f) => sum + factConfidence(f), 0) / dimFacts.length;

    if (freshness >= 0.5 && hasSources && confidence >= MIN_CONFIDENCE) {
      dimensions[dim] = 'COMPLETE';
    } else {
      dimensions[dim] = 'PARTIAL';
      if (!hasSources) gaps.push(`dimension "${dim}" lacks supporting sources`);
      if (freshness < 0.5) gaps.push(`dimension "${dim}" facts are stale or untimestamped`);
      if (confidence < MIN_CONFIDENCE) gaps.push(`dimension "${dim}" facts have low confidence`);
    }
  }

  const statuses = Object.values(dimensions);
  let overall: OverallStatus;
  if (statuses.some((s) => s === 'MISSING' || s === 'CONFLICTED')) {
    overall = 'INSUFFICIENT';
  } else if (statuses.some((s) => s === 'PARTIAL' || s === 'REALTIME_REQUIRED')) {
    overall = 'PARTIAL';
  } else {
    overall = 'COMPLETE';
  }

  const freshnessScore =
    safeFacts.length > 0
      ? safeFacts.reduce((sum, f) => sum + factFreshness(f, now), 0) / safeFacts.length
      : 0;

  let sourceQuality = 0;
  if (safeSources.length > 0) {
    sourceQuality =
      safeSources.reduce((sum, s) => {
        const q = s?.qualityScore;
        return sum + (typeof q === 'number' && !Number.isNaN(q) ? q : s?.isOfficial ? 0.8 : 0.5);
      }, 0) / safeSources.length;
  }

  const report: CoverageReport = {
    dimensions,
    overall,
    gaps,
    conflictCount,
    freshnessScore: round3(freshnessScore),
    sourceQuality: round3(sourceQuality),
  };
  void object;
  return report;
}
