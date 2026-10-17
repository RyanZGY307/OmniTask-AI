// ================================================================
// Cross Validation — cross-validate claims across evidence (pure, no DB/LLM)
// ================================================================

import type { CollectedEvidence } from './evidenceCollector';

export interface ClaimInput {
  claim: string;
  value: string;
  source: string;
}

export interface ConflictValue {
  value: string;
  source: string;
  domain: string;
  date?: string;
  conditions?: string;
}

export interface ConflictGroup {
  claim: string;
  values: ConflictValue[];
}

export interface ValidationReport {
  validated: string[];
  conflicted: ConflictGroup[];
  insufficient: string[];
}

function normClaim(claim: string): string {
  return String(claim ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function domainOfUrl(url: string): string {
  try {
    return new URL(String(url || '').toLowerCase()).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

const NUM_RE = /-?\d+(?:\.\d+)?/;
const UNIT_RE = /\b(gb|mb|tb|kb|ghz|mhz|khz|watt|w|v|ma|a|nm|mm|cm|m|kg|g|°c|℃|celsius|fps|ms|s|hz)\b/i;

interface ValueInfo {
  num: number | null;
  unit: string;
  key: string;
}

function parseValue(raw: string): ValueInfo {
  const s = String(raw ?? '').trim();
  const m = s.match(NUM_RE);
  const num = m ? parseFloat(m[0]) : null;
  const u = s.match(UNIT_RE);
  const unit = u ? u[1].toLowerCase().replace('°c', 'c').replace('℃', 'c') : '';
  const key = num !== null ? `${unit ? unit + ':' : ''}${roundTol(num, unit)}` : s.toLowerCase();
  return { num, unit, key };
}

// Numeric equality within 5% tolerance: bucket numbers so values within 5% share a key
function roundTol(num: number, unit: string): number {
  if (num === 0) return 0;
  const abs = Math.abs(num);
  const tol = abs * 0.05;
  if (tol === 0) return num;
  const digits = Math.max(0, Math.floor(Math.log10(tol))) - 1;
  return Number(num.toFixed(Math.max(0, digits)));
}

// Two parsed values agree when: identical string keys, or same unit and numbers within 5%
function valuesAgree(a: ValueInfo, b: ValueInfo): boolean {
  if (a.key === b.key) return true;
  if (a.num !== null && b.num !== null && a.unit === b.unit) {
    const maxAbs = Math.max(Math.abs(a.num), Math.abs(b.num));
    if (maxAbs === 0) return a.num === b.num;
    return Math.abs(a.num - b.num) <= maxAbs * 0.05;
  }
  return false;
}

interface EvidenceLookup {
  domainBySource: Map<string, string>;
  dateBySource: Map<string, string>;
}

function buildEvidenceLookup(evidence: CollectedEvidence[]): EvidenceLookup {
  const domainBySource = new Map<string, string>();
  const dateBySource = new Map<string, string>();
  for (const ev of evidence ?? []) {
    const key = String(ev.url || '').toLowerCase();
    if (ev.domain) domainBySource.set(key, ev.domain);
    if (ev.observedAt) {
      dateBySource.set(key, new Date(ev.observedAt).toISOString().slice(0, 10));
    }
  }
  return { domainBySource, dateBySource };
}

export function crossValidate(evidence: CollectedEvidence[], claims: ClaimInput[]): ValidationReport {
  const report: ValidationReport = { validated: [], conflicted: [], insufficient: [] };
  if (!claims || claims.length === 0) return report;

  const lookup = buildEvidenceLookup(evidence);

  const groups = new Map<string, ClaimInput[]>();
  for (const c of claims) {
    const key = normClaim(c.claim);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  for (const [key, entries] of groups.entries()) {
    // Distinct independent sources (domains) behind this claim
    const domains = new Set<string>();
    for (const e of entries) {
      const src = String(e.source || '').toLowerCase();
      domains.add(lookup.domainBySource.get(src) || domainOfUrl(src));
    }

    if (domains.size < 2) {
      report.insufficient.push(key);
      continue;
    }

    // Cluster values (agreement within 5% numeric tolerance / exact string match)
    const clusters: ValueInfo[] = [];
    for (const e of entries) {
      const info = parseValue(e.value);
      const merged = clusters.find((c) => valuesAgree(c, info));
      if (merged) {
        // keep the numerically-anchored cluster key
        if (info.num !== null && merged.num === null) clusters[clusters.indexOf(merged)] = info;
      } else {
        clusters.push(info);
      }
    }

    if (clusters.length === 1) {
      report.validated.push(key);
      continue;
    }

    const seen = new Set<string>();
    const values: ConflictValue[] = [];
    for (const e of entries) {
      const src = String(e.source || '');
      const srcLower = src.toLowerCase();
      const pairKey = `${normClaim(e.claim)}|${String(e.value ?? '').toLowerCase()}|${srcLower}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      values.push({
        value: String(e.value ?? ''),
        source: src,
        domain: lookup.domainBySource.get(srcLower) || domainOfUrl(src),
        date: lookup.dateBySource.get(srcLower),
      });
    }
    report.conflicted.push({ claim: key, values });
  }

  return report;
}
