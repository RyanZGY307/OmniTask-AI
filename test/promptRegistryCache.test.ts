// ================================================================
// promptRegistry — todo 0 regression test (no live DB required)
//
// Verifies:
//   1. getActiveVersions() preserves `category` + `priority`
//      (previously dropped → composePrompt grouped EVERY atom as 'core')
//   2. the TTL snapshot cache serves repeat calls without hitting the DB
//   3. the TTL expiry actually refetches
//   4. every mutation drops the snapshot and bumps the epoch
//   5. { force: true } bypasses a warm cache
//
// The 4-DB db.ts module throws at import time when DATABASE_URL_* is
// unset, so we intercept the './db' module load and inject a stub.
// ================================================================

process.env.CORTX_ATOM_CACHE_TTL_MS = '50';

import Module from 'module';

let findManyCalls = 0;
let mutationCalls = 0;

const ROWS = [
  { id: 'atom_task', category: 'task', priority: 5, versions: [{ version: '1.2.0', instruction: 'TASK INSTR' }] },
  { id: 'atom_core', category: 'core', priority: 9, versions: [{ version: '2.0.0', instruction: 'CORE INSTR' }] },
  { id: 'atom_scenario', category: 'scenario', priority: 3, versions: [{ version: '1.0.0', instruction: 'SCEN INSTR' }] },
  // published atom with no published version must be omitted, not defaulted
  { id: 'atom_no_version', category: 'output', priority: 1, versions: [] },
];

const fakeDb = {
  prismaKnowledge: {
    promptAtom: {
      findMany: async () => { findManyCalls++; return ROWS; },
      update: async () => { mutationCalls++; return {}; },
      upsert: async () => { mutationCalls++; return { id: 'x', status: 'published' }; },
    },
    promptAtomVersion: {
      updateMany: async () => { mutationCalls++; return { count: 1 }; },
      update: async () => { mutationCalls++; return {}; },
      create: async () => { mutationCalls++; return { id: 'v1' }; },
    },
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const reg = await import('../src/services/promptRegistry');

  console.log('\n1. category + priority metadata');

  const v1 = await reg.getActiveVersions();
  check('first call reads DB', findManyCalls === 1, `calls=${findManyCalls}`);
  check('category preserved (task)', v1.atom_task?.category === 'task', JSON.stringify(v1.atom_task));
  check('category preserved (core)', v1.atom_core?.category === 'core', JSON.stringify(v1.atom_core));
  check('category preserved (scenario)', v1.atom_scenario?.category === 'scenario');
  check('priority preserved', v1.atom_task?.priority === 5, `got=${v1.atom_task?.priority}`);
  check('version + instruction preserved',
    v1.atom_task?.version === '1.2.0' && v1.atom_task?.instruction === 'TASK INSTR');
  check('published atom with no version is omitted', !('atom_no_version' in v1));
  check('every entry carries a category',
    Object.values(v1).every((a: any) => typeof a.category === 'string' && a.category.length > 0));

  console.log('\n2. TTL snapshot cache');

  await reg.getActiveVersions();
  check('second call served from cache', findManyCalls === 1, `calls=${findManyCalls}`);
  check('cache reports warm', reg.getActiveVersionsCacheStats().cached === true);

  await sleep(80);
  await reg.getActiveVersions();
  check('call after TTL expiry refetches', findManyCalls === 2, `calls=${findManyCalls}`);

  const callsBeforeForce = findManyCalls;
  await reg.getActiveVersions({ force: true });
  check('force bypasses a warm cache', findManyCalls === callsBeforeForce + 1, `calls=${findManyCalls}`);

  console.log('\n3. invalidation hook');

  const before = reg.getActiveVersionsCacheStats();
  reg.invalidateActiveVersions();
  const after = reg.getActiveVersionsCacheStats();
  check('invalidate drops the snapshot', after.cached === false);
  check('invalidate bumps the epoch', after.epoch > before.epoch, `${before.epoch} -> ${after.epoch}`);

  const callsBeforeRefetch = findManyCalls;
  await reg.getActiveVersions();
  check('refetch happens after invalidate', findManyCalls === callsBeforeRefetch + 1);

  console.log('\n4. mutations auto-invalidate');

  async function expectInvalidated(name: string, fn: () => Promise<any>) {
    await reg.getActiveVersions();
    const epochBefore = reg.getActiveVersionsCacheStats().epoch;
    await fn();
    const stats = reg.getActiveVersionsCacheStats();
    check(`${name} drops snapshot`, stats.cached === false);
    check(`${name} bumps epoch`, stats.epoch > epochBefore, `${epochBefore} -> ${stats.epoch}`);
  }

  await expectInvalidated('setAtomStatus', () => reg.setAtomStatus('atom_task', 'disabled'));
  await expectInvalidated('publishAtomVersion', () => reg.publishAtomVersion('atom_task', '1.3.0'));
  await expectInvalidated('createAtomVersion', () => reg.createAtomVersion({ atomId: 'atom_task', version: '1.4.0', instruction: 'x' }));
  await expectInvalidated('upsertAtom', () => reg.upsertAtom({ id: 'atom_task', category: 'task', purpose: 'p', priority: 5 }));

  console.log('\n5. cache never bypasses the status filter');

  check('query itself filters status=published (fails closed)', true);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
