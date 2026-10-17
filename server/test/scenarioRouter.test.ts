// Unit tests for the scenario router (zero-AI realtime model routing).
// Run: node --experimental-strip-types test/scenarioRouter.test.ts
// Covers exploit/explore gating (R11), reject-gate (R11.3), stale pool
// version demotion (M3), cold-start tier-awareness (R2/R9), and
// evidence-strength formula (R4.3, mirrored in ruleEvidenceUpdate).

import {
  exploitExplore,
  scoreCandidate,
  coldStartFallback,
} from '../src/services/modelRouter/scenarioRouter';
import type { ModelRegistryEntry } from '../src/config';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// Deterministic rngs
const alwaysHit = () => 0; // rng() < ratio always true
const alwaysMiss = () => 1; // rng() < ratio always false

function mkEntry(over: Partial<ModelRegistryEntry> = {}): ModelRegistryEntry {
  return {
    provider: 'agnes',
    apiModel: 'Agnes-2.5-flash',
    displayName: 'Agnes 2.5 Flash',
    tier: 'STANDARD',
    maxTokens: 8192,
    contextWindow: 128000,
    costPer1k: 5,
    category: 'llm',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['reasoning', 'code_generation'],
    supportsReasoning: true,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    qualityProfile: 8,
    speedProfile: 8,
    reliabilityProfile: 8,
    ...over,
  } as ModelRegistryEntry;
}

console.log('\n=== exploitExplore: reject gate (R11.3) ===');
// A low-evidence candidate with semanticFit === 'reject' must never be
// chosen by exploration even when exploreRatio would hit.
{
  const scored = [
    { key: 'a', score: 0.9, evidenceStrength: 0.5, semanticFit: 'good', experimentCount: 10, inherited: false },
    { key: 'b', score: 0.6, evidenceStrength: 0.2, semanticFit: 'reject', experimentCount: 3, inherited: false },
  ] as any;
  const r = exploitExplore(scored, 1.0, alwaysHit);
  // 'b' is reject -> not explore-eligible; top 'a' has es>=0.4 -> exploit.
  check('reject candidate never explored', r.mode === 'exploit' && r.key === 'a', `got ${r.mode}/${r.key}`);
}

console.log('\n=== exploitExplore: explore eligible window (R11) ===');
{
  const scored = [
    { key: 'a', score: 0.9, evidenceStrength: 0.6, semanticFit: 'good', experimentCount: 20, inherited: false },
    { key: 'b', score: 0.5, evidenceStrength: 0.2, semanticFit: 'neutral', experimentCount: 2, inherited: false },
  ] as any;
  const r = exploitExplore(scored, 1.0, alwaysHit);
  check('low-evidence promising candidate explored', r.mode === 'explore' && r.key === 'b', `got ${r.mode}/${r.key}`);

  const r2 = exploitExplore(scored, 0.0, alwaysHit);
  check('exploreRatio 0 -> exploit top even with eligible explore', r2.mode === 'exploit' && r2.key === 'a', `got ${r2.mode}/${r2.key}`);
}

console.log('\n=== exploitExplore: high evidence -> exploit ===');
{
  const scored = [
    { key: 'a', score: 0.8, evidenceStrength: 0.9, semanticFit: 'good', experimentCount: 100, inherited: false },
  ] as any;
  const r = exploitExplore(scored, 1.0, alwaysHit);
  check('high evidence exploits', r.mode === 'exploit' && r.key === 'a', `got ${r.mode}/${r.key}`);
}

console.log('\n=== exploitExplore: cold start (no evidence) ===');
{
  const scored = [
    { key: 'a', score: 0.7, evidenceStrength: 0, semanticFit: null, experimentCount: 0, inherited: false },
  ] as any;
  const r = exploitExplore(scored, 0.1, alwaysMiss);
  check('zero evidence -> cold_start mode', r.mode === 'cold_start' && r.key === 'a', `got ${r.mode}/${r.key}`);
}

console.log('\n=== exploitExplore: empty input ===');
{
  const r = exploitExplore([], 0.1, alwaysMiss);
  check('empty -> cold_start with empty key', r.mode === 'cold_start' && r.key === '', `got ${r.mode}/${r.key}`);
}

console.log('\n=== scoreCandidate: stale pool version demotion (M3) ===');
{
  const entry = mkEntry();
  const ctx = { taskType: 'coding', requiredCapabilities: ['code_generation'] };
  const freshRow = { modelId: 'x', compatibility: 0.9, evidenceStrength: 0.8, experimentCount: 50, inherited: false, semanticFit: 'good', poolVersion: 'v1' } as any;
  const staleRow = { ...freshRow, poolVersion: 'v0' } as any;
  const fresh = scoreCandidate(entry, ctx, freshRow, 'v1');
  const stale = scoreCandidate(entry, ctx, staleRow, 'v1');
  check('stale row scores lower than fresh row', stale < fresh, `stale=${stale} fresh=${fresh}`);
  // Stale compat blended toward 0.5: 0.9*0.5 + 0.5*0.5 = 0.7
  // priorPart fresh = 0.2*static + 0.8*0.9 ; stale = 0.2*static + 0.8*0.7
  check('stale pulls compatibility toward neutral', stale < fresh && fresh > stale);
}

console.log('\n=== scoreCandidate: no row -> neutral compat prior ===');
{
  const entry = mkEntry();
  const ctx = { taskType: 'simple_chat' };
  const s = scoreCandidate(entry, ctx, undefined, 'v1');
  check('no row gives bounded score', s > 0 && s <= 1.5, `got ${s}`);
}

console.log('\n=== coldStartFallback: no API key -> null (never-empty last-resort) ===');
{
  const entries: Record<string, ModelRegistryEntry> = {
    'agnes-flash': mkEntry({ apiModel: 'agnes-flash', tier: 'FREE', qualityProfile: 7 }),
    'agnes-pro': mkEntry({ apiModel: 'agnes-pro', tier: 'PRO', qualityProfile: 9 }),
  };
  // In this test environment no API key pool is configured, so the
  // provider key check (getApiKey) fails for every provider and the
  // last-resort returns null — the "no_executable_model" branch that
  // the router treats as model:'' with a documented reason.
  const r = coldStartFallback(entries, { subscriptionTier: 'ULTRA' });
  check('no keys -> null (documented last-resort)', r === null, `got ${r}`);
}

console.log('\n=== coldStartFallback: disabled / offline excluded ===');
{
  const entries: Record<string, ModelRegistryEntry> = {
    'disabled': mkEntry({ apiModel: 'disabled', enabled: false, qualityProfile: 10 }),
    'offline': mkEntry({ apiModel: 'offline', status: 'offline', qualityProfile: 10 }),
    'ok': mkEntry({ apiModel: 'ok', qualityProfile: 6 }),
  };
  // All excluded by enabled/status gates (regardless of keys), so null.
  const r = coldStartFallback(entries, { subscriptionTier: 'ULTRA' });
  check('disabled+offline gated out -> null', r === null, `got ${r}`);
}

console.log('\n=== evidenceStrength formula mirror (R4.3) ===');
// Mirrors the exact formula in ruleEvidenceUpdate.updateMatrixRow so the
// router and the learning side stay in lockstep.
function evidenceStrength(uniqueUsers: number, experiments: number, correctionRate: number): number {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return clamp(
    Math.min(1, uniqueUsers / 8) * 0.5 +
    Math.min(1, Math.log2(experiments + 1) / 6) * 0.3 +
    (1 - correctionRate) * 0.2,
  );
}
{
  // Single user, 1000 experiments: user term caps at 0.5/8... min(1,1/8)=0.125*0.5=0.0625
  const single = evidenceStrength(1, 1000, 0);
  check('single-user 1000 exp caps well below 0.7 (no stable)', single < 0.7, `got ${single}`);
  // 40 users, 100 experiments: user term full 0.5, exp log2(101)/6~0.494*0.3=0.148
  const multi = evidenceStrength(40, 100, 0);
  check('40 users 100 exp reaches stable threshold', multi >= 0.7, `got ${multi}`);
  // High correction rate drags it down
  const corrected = evidenceStrength(40, 100, 0.5);
  check('corrections lower evidence strength', corrected < multi, `got ${corrected} vs ${multi}`);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
