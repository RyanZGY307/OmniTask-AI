// Resolver snapshot tests (todo 3) — no live DB.
// Public seams under test:
//   resolveConflicts(atomIds, versions?)
//   resolveDependencies(atomIds, versions?)
// What they catch: (a) a caller can pass one snapshot and avoid a per-call
// DB query, and (b) the metadata that drives conflict/dependency decisions
// actually flows through the snapshot.
import Module from 'module';

let dbCalls = 0;
const fakeDb = {
  prismaKnowledge: {
    promptAtom: { findMany: async () => { dbCalls++; return []; } },
    promptAtomVersion: {},
    $transaction: async (cb: any) => cb({
      promptAtom: { findUnique: async () => null, create: async () => ({}), update: async () => ({}) },
      promptAtomVersion: { create: async () => ({}) },
    }),
  },
};

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any) {
  if (request === './db' && parent && String(parent.filename).includes('services')) return fakeDb;
  return origLoad.apply(this, arguments as any);
};

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, extra = '') {
  if (condition) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

(async () => {
  const { resolveDependencies } = await import('../src/services/dependencyResolver');
  const { resolveConflicts } = await import('../src/services/conflictResolver');

  // Minimal, hand-written snapshot — the point is that no DB call happens.
  const versions: any = {
    'core.identity': { version: '1', instruction: 'i', category: 'core', priority: 100, requires: [], conflicts_with: [], compatible_with: [], extends: [], parent: null, tags: [], conditions: {} },
    'task.child': { version: '1', instruction: 'i', category: 'task', priority: 60,
      requires: ['core.identity'], conflicts_with: [], compatible_with: [], extends: ['task.decorator'], parent: 'core.identity', tags: [], conditions: {} },
    'task.decorator': { version: '1', instruction: 'i', category: 'task', priority: 50, requires: [], conflicts_with: [], compatible_with: [], extends: [], parent: null, tags: [], conditions: {} },
    // conflicts_with core.identity, but at LOWER priority -> the existing atom must win.
    'task.weak_conflict': { version: '1', instruction: 'i', category: 'task', priority: 10, requires: [], conflicts_with: ['core.identity'], compatible_with: [], extends: [], parent: null, tags: [], conditions: {} },
    // conflicts_with core.identity at HIGHER priority -> the new atom must win.
    'task.strong_conflict': { version: '1', instruction: 'i', category: 'task', priority: 999, requires: ['task.ghost'], conflicts_with: ['core.identity'], compatible_with: [], extends: [], parent: null, tags: [], conditions: {} },
  };

  console.log('\n1. dependency resolution from a snapshot (no DB query)');
  const before = dbCalls;
  const dep = await resolveDependencies(['task.child'], versions);
  check('no DB query when a snapshot is supplied', dbCalls === before, `calls=${dbCalls}`);
  check('requires + parent + extends all pull in their targets',
    dep.resolved_atoms.length === 3,
    JSON.stringify(dep.resolved_atoms));
  check('dependency target resolved', dep.resolved_atoms.includes('core.identity'));
  check('extends target resolved', dep.resolved_atoms.includes('task.decorator'));
  check('no missing deps for resolvable graph', dep.missing_deps.length === 0, JSON.stringify(dep.missing_deps));

  const missing = await resolveDependencies(['task.strong_conflict'], versions);
  check('missing dependency is reported, not silently ignored',
    missing.missing_deps.includes('task.ghost'), JSON.stringify(missing.missing_deps));
  check('atom with a missing dependency is removed from the final set',
    !missing.resolved_atoms.includes('task.strong_conflict'));

  console.log('\n2. conflict resolution from a snapshot (no DB query)');
  const beforeConf = dbCalls;
  const weak = await resolveConflicts(['core.identity', 'task.weak_conflict'], versions);
  check('no DB query when a snapshot is supplied', dbCalls === beforeConf, `calls=${dbCalls}`);
  check('lower-priority conflict is dropped', !weak.final_atoms.includes('task.weak_conflict'), JSON.stringify(weak.final_atoms));
  check('higher-priority existing atom is kept', weak.final_atoms.includes('core.identity'));
  check('conflict is reported', weak.conflicts.length === 1, JSON.stringify(weak.conflicts));

  const strong = await resolveConflicts(['core.identity', 'task.strong_conflict'], versions);
  check('higher-priority new atom wins', strong.final_atoms.includes('task.strong_conflict'), JSON.stringify(strong.final_atoms));
  check('lower-priority existing atom is dropped', !strong.final_atoms.includes('core.identity'));

  console.log('\n3. no snapshot -> falls back to the registry (single query)');
  const beforeFallback = dbCalls;
  const fallback = await resolveDependencies(['task.child']);
  check('fallback queries the registry exactly once', dbCalls === beforeFallback + 1, `calls=${dbCalls}`);
  check('empty snapshot yields missing deps (known-empty stub), not a crash',
    fallback.missing_deps.includes('task.child'), JSON.stringify(fallback.missing_deps));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
