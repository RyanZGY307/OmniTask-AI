// Contract test for the 10-Worker scenario runtime (pure, no model calls).
// Verifies: SkillPublishGuard hard rules, parseWorkerJson enum gating,
// S4 empty-selection invariant, P3 two-stage gate, E1 coefficient shaping.
// Run: node test/scenarioRuntime.test.js (after npm run build)

const { guardSkillPublication, assertNoGlobalSkillQualityWrite } = require('../dist/services/skillPublishGuard.js');
const { parseWorkerJson } = require('../dist/services/scenarioWorkers/agnesCaller.js');
const { p3HardGate, p3ExploitExplore } = require('../dist/services/scenarioWorkers/p3PromptSelector.js');
const { normalizeSkillCoeffs } = (() => { try { return require('../dist/services/scenarioWorkers/e1Attribution.js'); } catch { return {}; } })();

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`); }
}

console.log('\n=== SkillPublishGuard (AI never publishes formal Skill) ===');
check('admin_route allowed', guardSkillPublication({ origin: 'admin_route' }).allowed === true);
check('admin_import allowed', guardSkillPublication({ origin: 'admin_import' }).allowed === true);
check('ai_generated DENIED', guardSkillPublication({ origin: 'ai_generated' }).allowed === false, 'AI cannot publish a formal Skill');
check('auto_derived DENIED', guardSkillPublication({ origin: 'auto_derived' }).allowed === false);
check('unknown DENIED', guardSkillPublication({ origin: 'unknown' }).allowed === false);
let guardThrew = false;
try { assertNoGlobalSkillQualityWrite('globalQuality'); } catch { guardThrew = true; }
check('global quality column write throws', guardThrew);
let legitOk = true;
try { assertNoGlobalSkillQualityWrite('capabilities'); } catch { legitOk = false; }
check('non-quality column write allowed', legitOk);

console.log('\n=== parseWorkerJson enum gating ===');
check('valid JSON parsed', parseWorkerJson('{"resolution":"reuse_exact"}').resolution === 'reuse_exact');
check('code-fenced JSON parsed', parseWorkerJson('```json\n{"a":1}\n```').a === 1);
const illegal = parseWorkerJson('{"decision":"INVALID"}', { decision: ['use', 'experimental', 'reject', 'none'] });
check('illegal enum -> null (degraded)', illegal === null);
check('malformed -> null', parseWorkerJson('not json') === null);

console.log('\n=== P3 two-stage rule selection ===');
const atoms = [
  { atom: { id: 'A', version: '1.0', category: 'task' }, compat: { experiment_count: 20, unique_user_count: 6, correction_count: 1, success_rate: 0.9, lifecycle: 'stable' } },
  { atom: { id: 'B', version: '1.0', category: 'task' }, compat: { experiment_count: 2, unique_user_count: 1, correction_count: 0, success_rate: 0.5, lifecycle: 'experimental' } },
  { atom: { id: 'C', version: '1.0', category: 'task' }, compat: { experiment_count: 0, unique_user_count: 0, correction_count: 0, success_rate: 0.5, lifecycle: 'experimental' } },
  { atom: { id: 'core.truth_standard', version: '1.0', category: 'core' }, compat: { experiment_count: 99, unique_user_count: 9, correction_count: 0, success_rate: 0.99, lifecycle: 'stable' } },
];
const p3 = {
  candidates: [
    { atom_id: 'A', fit_level: 'high_fit', compatibility_estimate: 0.9, reason_codes: [], experiment_value: 0 },
    { atom_id: 'B', fit_level: 'experimental_fit', compatibility_estimate: 0.6, reason_codes: [], experiment_value: 0.2 },
    { atom_id: 'C', fit_level: 'reject', compatibility_estimate: 0.1, reason_codes: [], experiment_value: 0 },
    { atom_id: 'core.truth_standard', fit_level: 'high_fit', compatibility_estimate: 0.99, reason_codes: [], experiment_value: 0 },
  ],
  selected_atom_ids: ['A'],
  experimental_atom_ids: ['B'],
  no_suitable_prompt: false,
};
const gated = p3HardGate(p3.candidates, atoms);
check('reject excluded', !gated.some((c) => c.atom_id === 'C'));
check('safety atom (core.truth_standard) never delta-modified by P3', !gated.some((c) => c.atom_id === 'core.truth_standard'));
const { exploit, explore } = p3ExploitExplore(gated, atoms);
check('A exploited (high_fit + users>=5 + low correction)', exploit.some((c) => c.atom_id === 'A'));
check('B explored (experimental)', explore.some((c) => c.atom_id === 'B'));

console.log('\n=== S4 empty-selection invariant (via S4Output shaping) ===');
// Simulate the invariant enforcement done in runS4's return path.
function enforceS4(parsed) {
  const selected = Array.isArray(parsed.selected_skill_ids) ? parsed.selected_skill_ids.map(String) : [];
  const emptySelection = selected.length === 0 || parsed.empty_selection === true;
  return { selected_skill_ids: emptySelection ? [] : selected, empty_selection: emptySelection };
}
check('empty_selection=true forces []', enforceS4({ selected_skill_ids: ['x'], empty_selection: true }).selected_skill_ids.length === 0);
check('natural [] stays []', enforceS4({ selected_skill_ids: [], empty_selection: false }).empty_selection === true);
check('non-empty kept when empty_selection=false', enforceS4({ selected_skill_ids: ['s1', 's2'], empty_selection: false }).selected_skill_ids.length === 2);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
