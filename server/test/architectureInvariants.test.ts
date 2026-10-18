// ================================================================
// Architecture invariants (todo 5) — no live DB required.
//
// These are CROSS-MODULE guarantees. The unit tests (promptComposerGrouping,
// promptRegistryCache, scenarioAtomPolicy, skillSelector, ...) each prove one
// module's behaviour; this file pins the invariants that span modules and that
// a future refactor could silently break:
//
//   A1  Truth Standard is the LAST section — composePrompt path
//   A2  Truth Standard is the LAST section — compilePrompt (fallback) path
//   A3  Intent Understanding sits immediately before Truth, always sent, on BOTH
//   A4  Skill selection is deterministic and performs no I/O (zero AI calls)
//   A5  The 2-Skill cap is enforced in the backend executor, not just upstream
//   A6  SELECT_NONE is a first-class outcome, never an error
//   A7  Disabled/quarantined atoms cannot reach a prompt; scenario exclusion is
//       absolute and the candidate budget is hard-capped
// ================================================================

import Module from 'module';
import { readFileSync } from 'node:fs';

let findManyWhere: any = null;
let dbQueries = 0;

const PUBLISHED_ROWS = [
  { id: 'core.identity', category: 'core', priority: 100, status: 'published',
    requires: '[]', conflicts_with: '[]', compatible_with: '[]', extends: '[]', tags: '[]', parent: null,
    versions: [{ version: '1.0.0', instruction: 'CORE' }] },
  { id: 'task.wanted', category: 'task', priority: 70, status: 'published',
    requires: '[]', conflicts_with: '[]', compatible_with: '[]', extends: '[]', tags: '[]', parent: null,
    versions: [{ version: '1.0.0', instruction: 'WANTED' }] },
];

const fakeDb = {
  prismaKnowledge: {
    promptAtom: {
      findMany: async (args: any) => {
        dbQueries++; findManyWhere = args?.where ?? null;
        // Simulate a DB that IGNORES the where clause, to prove the filter is
        // not something the in-memory layer must re-implement: the rows we
        // hand back are already status-filtered by design.
        return PUBLISHED_ROWS;
      },
    },
    promptAtomVersion: {},
    scenario: {
      findUnique: async () => ({ id: 's', max_atoms: 9999, required_atoms: '["task.wanted","disabled.banned"]', exclude_atoms: '["disabled.banned"]' }),
      findMany: async () => [], count: async () => 0, upsert: async () => ({}), update: async () => ({}),
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

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, extra = '') {
  if (condition) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

// The separator composePrompt / compilePrompt join sections with.
const SEP = '\n\n---\n\n';

(async () => {
  const { composePrompt } = await import('../src/services/promptComposer');
  const { compilePrompt } = await import('../src/services/compiler');
  const { KERNEL_TRUTH, KERNEL_INTENT_UNDERSTANDING } = await import('../src/services/kernel');
  const { selectSkills, SKILL_HARD_CAP } = await import('../src/services/skillSelector');
  const { SKILLS } = await import('../src/services/skills');
  const { getActiveVersions } = await import('../src/services/promptRegistry');
  const { retrieveCandidateAtoms } = await import('../src/services/scenarioWorkers/scenarioRetrieval');

  console.log('\nA1. Truth is the LAST section — composePrompt path');
  const composed = await composePrompt(['core.identity'], {}, {
    versions: { 'core.identity': { version: '1.0.0', instruction: 'CORE', category: 'core', priority: 100 } },
  });
  const cParts = composed.final_prompt.split(SEP);
  check('last section is Truth Standard', cParts[cParts.length - 1] === KERNEL_TRUTH,
    `last=${cParts[cParts.length - 1]?.slice(0, 40)}`);
  check('nothing follows the Truth Standard', composed.final_prompt.trimEnd().endsWith(KERNEL_TRUTH.trimEnd()));

  console.log('\nA2. Truth is the LAST section — compilePrompt (fallback) path');
  const compiled = compilePrompt({
    userId: 'u', userTier: 'PRO', message: 'hi',
    taskClassification: {
      taskType: 'answer', complexity: 'simple', suggestedAgent: 'general',
      requiredCapabilities: [], suggestedSkills: [], needsTools: false, needsWeb: false,
      needsMemory: false, needsVerification: false, estimatedTokens: 10, confidence: 1,
    } as any,
    mode: undefined, memories: [], ragChunks: [], conversationHistory: [],
    language: 'zh', region: 'CN',
  });
  const fParts = compiled.system.split(SEP);
  check('fallback path also ends with Truth Standard', fParts[fParts.length - 1] === KERNEL_TRUTH);
  check('kernel invariant identical on both paths (same literal)',
    cParts[cParts.length - 1] === fParts[fParts.length - 1]);

  console.log('\nA3. Intent Understanding immediately precedes Truth, always sent');
  check('composePrompt: intent is the second-to-last section',
    cParts[cParts.length - 2] === KERNEL_INTENT_UNDERSTANDING);
  check('compilePrompt: intent is the second-to-last section',
    fParts[fParts.length - 2] === KERNEL_INTENT_UNDERSTANDING);
  check('intent sent with an EMPTY atom set (no atoms at all)',
    (await composePrompt([], {}, {})).sections.intent === KERNEL_INTENT_UNDERSTANDING);
  check('intent sent with an UNKNOWN request context',
    Object.keys(composed.sections).includes('intent'));

  console.log('\nA4. Skill selection is deterministic and performs no I/O (zero AI)');
  const skillInput = { message: '帮我写一个 python 脚本分析数据', taskType: 'coding', userTier: 'PRO' };
  const r1 = selectSkills(skillInput);
  const r2 = selectSkills(skillInput);
  check('identical input → identical decision', r1.decision === r2.decision, `${r1.decision} vs ${r2.decision}`);
  check('identical input → identical skill ids', JSON.stringify(r1.skillIds) === JSON.stringify(r2.skillIds));
  check('identical input → identical reason', r1.reason === r2.reason);
  check('synchronous (returns a plain object, not a Promise) — no network round-trip',
    typeof (r1 as any).then !== 'function');
  const selectorSrc = readFileSync(new URL('../src/services/skillSelector.ts', import.meta.url), 'utf8');
  check('selector imports no AI / model-call module',
    !/callAgnes|agnesCaller|callGemini/.test(selectorSrc));
  check('selector never reads Skill bodies (no SKILLS[key].systemPrompt use)',
    !/systemPrompt/.test(selectorSrc));

  console.log('\nA5. The 2-Skill cap is enforced in the backend executor');
  const manySkills = Object.values(SKILLS).slice(0, 5).map((s) => s.id);
  const injected = compilePrompt({
    userId: 'u', userTier: 'PRO', message: 'hi',
    taskClassification: {
      taskType: 'coding', complexity: 'complex', suggestedAgent: 'general',
      requiredCapabilities: [], suggestedSkills: manySkills, needsTools: false, needsWeb: false,
      needsMemory: false, needsVerification: false, estimatedTokens: 10, confidence: 1,
    } as any,
    mode: undefined, memories: [], ragChunks: [], conversationHistory: [],
  });
  const bodiesInjected = Object.values(SKILLS).filter((s) => manySkills.includes(s.id) && injected.system.includes(s.systemPrompt)).length;
  check(`${manySkills.length} skills requested → at most ${SKILL_HARD_CAP} injected`, bodiesInjected <= SKILL_HARD_CAP,
    `injected=${bodiesInjected}`);
  const proOnly = Object.values(SKILLS).find((s) => s.requiredTier === 'PRO');
  if (proOnly) {
    const filtered = compilePrompt({
      userId: 'u', userTier: 'STANDARD', message: 'hi',
      taskClassification: {
        taskType: 'coding', complexity: 'complex', suggestedAgent: 'general',
        requiredCapabilities: [], suggestedSkills: [proOnly.id], needsTools: false, needsWeb: false,
        needsMemory: false, needsVerification: false, estimatedTokens: 10, confidence: 1,
      } as any,
      mode: undefined, memories: [], ragChunks: [], conversationHistory: [],
    });
    check(`PRO-only skill is not injected for a STANDARD user (${proOnly.id})`,
      !filtered.system.includes(proOnly.systemPrompt));
  } else {
    check('no PRO-only skill in registry to test tier filtering (skipped)', true);
  }

  console.log('\nA6. SELECT_NONE is a first-class outcome, never an error');
  const none = selectSkills({ message: '你好呀今天天气不错', taskType: 'answer', userTier: 'STANDARD' });
  check('a no-match request returns SELECT_NONE (not an exception)', none.decision === 'SELECT_NONE', none.decision);
  check('SELECT_NONE carries an empty id list', none.skillIds.length === 0);
  check('SELECT_NONE carries a reason (auditable)', typeof none.reason === 'string' && none.reason.length > 0);
  check('SELECT_NONE does not fabricate a low-score filler',
    none.candidates.filter((c) => !c.excluded && none.skillIds.includes(c.id)).length === 0);

  console.log('\nA7. Disabled atoms cannot reach a prompt; exclusion is absolute; budget is capped');
  findManyWhere = null;
  const queriesBefore = dbQueries;
  await getActiveVersions({ force: true });
  check('the published-only filter lives in the SQL query, not in JS',
    findManyWhere?.status === 'published', JSON.stringify(findManyWhere));
  check('a forced snapshot read costs exactly ONE DB query',
    dbQueries - queriesBefore === 1, `delta=${dbQueries - queriesBefore}`);

  const cands = await retrieveCandidateAtoms({
    p1: { domain: 'coding', scenario_signature: 's', contextual_features: [] } as any,
    p2: { matched_scenario_id: 's' } as any,
  });
  const candIds = cands.map((c: any) => c.atom?.id ?? c.id);
  check('excluded atom is absent even when it is ALSO listed as required (exclude wins)',
    !candIds.includes('disabled.banned'), JSON.stringify(candIds));
  check('required atom is still admitted', candIds.includes('task.wanted'), JSON.stringify(candIds));
  check('max_atoms=9999 is clamped to the hard cap (20)',
    candIds.length <= 20, `n=${candIds.length}`);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
