// ================================================================
// Scenario atom policy test (todo 1) — no live DB.
//
// The Scenario model stores required_atoms / optional_atoms /
// exclude_atoms as JSON strings defaulting to "". Before this fix:
//   - those four columns were written but NEVER read, so every scenario
//     got the same arbitrary "first N published atoms" candidate set;
//   - `JSON.parse(skill.capabilities || '[]')` was fine for "", but the
//     scenario columns themselves were never parsed at all;
//   - a malformed value would have thrown inside a `.catch(() => [])`,
//     silently yielding ZERO atoms for the whole request.
// ================================================================

import Module from 'module';

const ATOMS = [
  { id: 'core.identity', category: 'core', version: '1.0.0', priority: 100, status: 'published' },
  { id: 'core.concise', category: 'core', version: '1.0.0', priority: 60, status: 'published' },
  { id: 'task.analysis', category: 'task', version: '1.0.0', priority: 70, status: 'published' },
  { id: 'task.math', category: 'task', version: '1.0.0', priority: 70, status: 'published' },
  { id: 'output.json', category: 'output', version: '1.0.0', priority: 50, status: 'published' },
  { id: 'verification.fact', category: 'verification', version: '1.0.0', priority: 65, status: 'published' },
  { id: 'draft.secret', category: 'core', version: '1.0.0', priority: 99, status: 'draft' },
  { id: 'disabled.banned', category: 'task', version: '1.0.0', priority: 99, status: 'disabled' },
];

let scenarioRow: any = null;
let lastWhere: any = null;

const fakeDb = {
  prismaKnowledge: {
    scenario: {
      findUnique: async ({ where }: any) => (where.id === scenarioRow?.id ? scenarioRow : null),
      findMany: async () => [], count: async () => 0, upsert: async () => ({}), update: async () => ({}),
    },
    promptAtom: {
      findMany: async ({ where }: any) => {
        lastWhere = where;
        let rows = ATOMS.filter((a) => (where.status ? a.status === where.status : true));
        if (where.id?.in) rows = rows.filter((a) => where.id.in.includes(a.id));
        if (where.id?.notIn) rows = rows.filter((a) => !where.id.notIn.includes(a.id));
        rows = [...rows].sort((a, b) => b.priority - a.priority);
        return rows;
      },
    },
    scenarioPromptCompat: { findUnique: async () => null },
  },
};

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any) {
  if (request === './db' && parent && String(parent.filename).includes('services')) return fakeDb;
  if (request === '../db' && parent && String(parent.filename).includes('scenarioWorkers')) return fakeDb;
  return origLoad.apply(this, arguments as any);
};

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

(async () => {
  const { parseAtomList, getAtomPolicy, DEFAULT_MAX_ATOMS, ATOM_CANDIDATE_HARD_CAP } =
    await import('../src/services/scenarioRegistry');
  const { retrieveCandidateAtoms } = await import('../src/services/scenarioWorkers/scenarioRetrieval');

  const p1: any = { domain: 'coding', scenario_signature: 's', contextual_features: [] };
  const run = (sid: string | null) =>
    retrieveCandidateAtoms({ p1, p2: { matched_scenario_id: sid } as any });

  console.log('\n1. parseAtomList never throws');

  check('JSON array parsed', JSON.stringify(parseAtomList('["a","b"]')) === '["a","b"]');
  check('real array passthrough', JSON.stringify(parseAtomList(['a', 'b'])) === '["a","b"]');
  check('EMPTY STRING yields [] (was the crash source)', parseAtomList('').length === 0);
  check('null yields []', parseAtomList(null).length === 0);
  check('undefined yields []', parseAtomList(undefined).length === 0);
  check('malformed JSON yields [] (never throws)', parseAtomList('{"oops').length === 0);
  check('truncated array fails closed (no phantom ids)', parseAtomList('["a","b').length === 0);
  check('legacy comma string parsed', JSON.stringify(parseAtomList('a, b ,c')) === '["a","b","c"]');
  check('bare id parsed', JSON.stringify(parseAtomList('a')) === '["a"]');
  check('non-string entries dropped', JSON.stringify(parseAtomList(['a', 1, null, 'b'])) === '["a","b"]');
  check('duplicates removed', JSON.stringify(parseAtomList(['a', 'a', 'b'])) === '["a","b"]');
  check('whitespace trimmed', JSON.stringify(parseAtomList(['  a  '])) === '["a"]');
  check('object (not array) yields []', parseAtomList('{"a":1}').length === 0);

  console.log('\n2. getAtomPolicy — max_atoms clamping + exclude precedence');

  check('empty row → DEFAULT_MAX_ATOMS',
    getAtomPolicy({}).maxAtoms === DEFAULT_MAX_ATOMS, `got=${getAtomPolicy({}).maxAtoms}`);
  check('max_atoms=0 → DEFAULT (not zero atoms)', getAtomPolicy({ max_atoms: 0 }).maxAtoms === DEFAULT_MAX_ATOMS);
  check('negative max_atoms → DEFAULT', getAtomPolicy({ max_atoms: -5 }).maxAtoms === DEFAULT_MAX_ATOMS);
  check('NaN max_atoms → DEFAULT', getAtomPolicy({ max_atoms: 'abc' }).maxAtoms === DEFAULT_MAX_ATOMS);
  check('max_atoms clamped to hard cap',
    getAtomPolicy({ max_atoms: 9999 }).maxAtoms === ATOM_CANDIDATE_HARD_CAP);
  check('sane max_atoms honored', getAtomPolicy({ max_atoms: 5 }).maxAtoms === 5);

  const pol = getAtomPolicy({
    required_atoms: '["core.identity","core.concise"]',
    optional_atoms: '["task.analysis"]',
    exclude_atoms: '["core.concise"]',
  });
  check('required parsed', pol.required.includes('core.identity'));
  check('EXCLUDE WINS over required', !pol.required.includes('core.concise'), JSON.stringify(pol.required));
  check('exclude list intact', pol.exclude.includes('core.concise'));
  check('optional parsed', pol.optional.includes('task.analysis'));

  console.log('\n3. retrieveCandidateAtoms honors the scenario policy');

  scenarioRow = {
    id: 'coding.x', max_atoms: 3,
    required_atoms: '["core.identity","task.analysis"]',
    optional_atoms: '["output.json"]',
    exclude_atoms: '["task.math"]',
  };
  const r1 = await run('coding.x');
  const ids1 = r1.map((c) => c.atom.id);
  check('required atoms present', ids1.includes('core.identity') && ids1.includes('task.analysis'), ids1.join(','));
  check('excluded atom absent even though published', !ids1.includes('task.math'), ids1.join(','));
  check('max_atoms respected (3)', ids1.length === 3, `len=${ids1.length} ${ids1.join(',')}`);
  check('unpublished draft never retrieved', !ids1.includes('draft.secret'));
  check('disabled atom never retrieved', !ids1.includes('disabled.banned'));

  console.log('\n4. exclude is absolute even against a top-up');
  scenarioRow = {
    id: 'coding.y', max_atoms: 20,
    required_atoms: '["core.identity"]',
    optional_atoms: '[]',
    exclude_atoms: '["output.json","task.math"]',
  };
  const r2 = await run('coding.y');
  const ids2 = r2.map((c) => c.atom.id);
  check('excluded ids never appear after top-up',
    !ids2.includes('output.json') && !ids2.includes('task.math'), ids2.join(','));
  check('top-up fills the budget', ids2.length >= 2, ids2.join(','));

  console.log('\n5. malformed policy degrades, never blanks the request');
  scenarioRow = { id: 'coding.z', max_atoms: 4, required_atoms: '{bad json', optional_atoms: '', exclude_atoms: 'nope[' };
  const r3 = await run('coding.z');
  check('request still yields atoms (no silent zero)', r3.length > 0, `len=${r3.length}`);
  check('no crash from malformed columns', Array.isArray(r3));

  console.log('\n6. no scenario matched → published fallback');
  scenarioRow = null;
  const r4 = await run('does.not.exist');
  check('falls back to published atoms', r4.length > 0, `len=${r4.length}`);
  check('draft still excluded in fallback', !r4.map((c) => c.atom.id).includes('draft.secret'));

  console.log('\n7. filters are pushed into SQL, not post-filtered');
  check('query always constrains status=published', lastWhere?.status === 'published', JSON.stringify(lastWhere));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
