// ================================================================
// promptComposer — real-category grouping regression test
//
// This is the payoff of todo 0: before it, getActiveVersions() dropped
// `category`, so composePrompt's `(atom as any).category || 'core'`
// fallback assigned EVERY atom to the 'system' group. That collapsed
// [SYSTEM]/[RUNTIME]/[TASK]/[KNOWLEDGE] into one block and made the
// section ordering in the priority table meaningless.
//
// No live DB: './db' is intercepted before promptRegistry loads.
// ================================================================

import Module from 'module';

const fakeDb = {
  prismaKnowledge: {
    promptAtom: { findMany: async () => [] },
    promptAtomVersion: {},
  },
};

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any) {
  if (request === './db' && parent && String(parent.filename).includes('services')) return fakeDb;
  return origLoad.apply(this, arguments as any);
};

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

(async () => {
  const { composePrompt } = await import('../src/services/promptComposer');

  // Snapshot exactly as getActiveVersions now returns it (with category).
  const versions = {
    a_core:     { version: '1.0.0', instruction: 'CORE_TEXT',     category: 'core',     priority: 9 },
    a_task:     { version: '1.0.0', instruction: 'TASK_TEXT',     category: 'task',     priority: 5 },
    a_domain:   { version: '1.0.0', instruction: 'DOMAIN_TEXT',   category: 'domain',   priority: 4 },
    a_research: { version: '1.0.0', instruction: 'RESEARCH_TEXT', category: 'research', priority: 3 },
    a_scenario: { version: '1.0.0', instruction: 'SCENARIO_TEXT', category: 'scenario', priority: 2 },
    a_output:   { version: '1.0.0', instruction: 'OUTPUT_TEXT',   category: 'output',   priority: 1 },
  };

  console.log('\n1. atoms land in their own priority groups');
  const r = await composePrompt(
    Object.keys(versions),
    {},
    { versions },
  );

  check('all 6 atoms selected', r.selected_atoms.length === 6, JSON.stringify(r.selected_atoms));
  check('no atoms dropped', r.removed_atoms.length === 0, JSON.stringify(r.removed_atoms));

  // system group holds core only
  check('system group = core', !!r.sections.system && r.sections.system.includes('CORE_TEXT'));
  check('system group excludes task text', !!r.sections.system && !r.sections.system.includes('TASK_TEXT'));

  // runtime group gets scenario
  check('runtime group = scenario', !!r.sections.runtime && r.sections.runtime.includes('SCENARIO_TEXT'));

  // task group gets task + domain
  check('task group has TASK_TEXT', !!r.sections.task && r.sections.task.includes('TASK_TEXT'));
  check('task group has DOMAIN_TEXT', !!r.sections.task && r.sections.task.includes('DOMAIN_TEXT'));

  // knowledge group gets research
  check('knowledge group = research', !!r.sections.knowledge && r.sections.knowledge.includes('RESEARCH_TEXT'));

  // output group gets output
  check('output group = output', !!r.sections.output && r.sections.output.includes('OUTPUT_TEXT'));

  console.log('\n2. sections are distinct (no collapse into one bucket)');
  const keys = Object.keys(r.sections);
  check('5+ distinct sections produced', keys.length >= 5, keys.join(','));
  // The pre-fix bug: every atom fell back to 'core' → one giant 'system'
  // section. Assert domain/task/research/output texts are NOT all in 'system'.
  const sys = r.sections.system || '';
  const misplaced = ['TASK_TEXT', 'DOMAIN_TEXT', 'RESEARCH_TEXT', 'OUTPUT_TEXT', 'SCENARIO_TEXT']
    .filter((t) => sys.includes(t));
  check('no non-core text leaked into the system group', misplaced.length === 0, misplaced.join(','));

  console.log('\n3. kernel invariants held');
  check('intent chapter present', !!r.sections.intent);
  check('truth section present', !!r.sections.truth);
  const text = r.final_prompt;
  const iTruth = text.indexOf(r.sections.truth);
  const iIntent = text.indexOf(r.sections.intent);
  check('truth is the LAST section', iTruth > iIntent && iTruth > 0, `truth@${iTruth} intent@${iIntent}`);
  check('intent sits immediately before truth', iIntent < iTruth);

  console.log('\n4. grouping is deterministic / order-stable');
  const r2 = await composePrompt(Object.keys(versions), {}, { versions });
  check('same input → identical composition_hash', r.composition_hash === r2.composition_hash,
    `${r.composition_hash} vs ${r2.composition_hash}`);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
