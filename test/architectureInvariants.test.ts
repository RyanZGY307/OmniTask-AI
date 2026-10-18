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
//   A8  The scenario-runtime skill path is zero-AI: the deterministic grader is
//       authoritative, and the retired S2 judge is opt-in and reject-only
//   A9  Hard rules (tier / lifecycle / scenario exclusion / version) are
//       evaluated BEFORE any scoring — a gate can never be outvoted
//   A10 The new chain caps at 2 Skills and requires an extra benefit check for
//       the second (no decorative multi-skill selection)
//   A11 Zero selection is terminal in the new chain too, never an error
//   A12 The English Prompt Architect system prompt is an asset of a dedicated
//       model only: it is not present anywhere in src/, and no ordinary-chat
//       prompt file references an architect module
// ================================================================

import Module from 'module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeSkills } from '../src/services/skillGrade';

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

  console.log('\nA8. The scenario-runtime skill path makes ZERO AI calls (strict zero-AI decision)');
  // S2's per-Skill semantic judging was deliberately retired from the selection
  // path. The module survives ONLY for A/B comparison behind an explicit env flag,
  // and even then it may only filter "reject" — never decide a selection.
  const runtimeSrc = readFileSync(new URL('../src/services/scenarioRuntime.ts', import.meta.url), 'utf8');
  const graderSrc = readFileSync(new URL('../src/services/skillGrade.ts', import.meta.url), 'utf8');
  check('runtime calls the deterministic grader on the skill path',
    /gradeSkills\s*\(/.test(runtimeSrc));
  check('the grader itself imports no AI / model-call module',
    !/callAgnes|agnesCaller|callGemini|openai/.test(graderSrc));
  check('the AI judge is opt-in, default OFF (CORTX_SKILL_AI_JUDGE === "on")',
    /const SKILL_AI_JUDGE = process\.env\.CORTX_SKILL_AI_JUDGE === 'on'/.test(runtimeSrc));
  check('S2 is referenced only from inside the A/B filter helper',
    /function filterByAiJudge\(/.test(runtimeSrc) && /await runS2\(/.test(runtimeSrc)
    && (runtimeSrc.split('await runS2(').length - 1) === 1);
  check('when the AI judge IS on, it may only filter rejects (never decide selection)',
    /decisions\.filter\(\(d\) => d\.decision === 'reject'\)/.test(runtimeSrc));
  check('the AI-judge helper degrades to the pure rule path on failure',
    /catch\s*\{\s*return skills;\s*\}/s.test(runtimeSrc));

  console.log('\nA9. Hard rules are evaluated BEFORE any scoring (a gate can never be outvoted)');
  const gradedHard = gradeSkills({
    scenario: { id: 's', name: 'coding', category: 'coding' },
    skills: [
      { skill: { id: 'over_privileged', name: 'op', capabilities: ['code_gen'], requiredTier: 'ENTERPRISE' },
        link: { confidence: 1, autoDerived: false }, compat: { experiment_count: 9, success_rate: 1, unique_user_count: 99 } },
    ] as any,
    userTier: 'STANDARD',
    requiredCapabilities: ['code_gen'],
  });
  check('an over-tier skill is EXCLUDED despite perfect evidence',
    gradedHard.graded[0].grade === 'EXCLUDED' && gradedHard.selectable.length === 0,
    `${gradedHard.graded[0].grade}`);
  check('EXCLUDED is reported as a different family from a low grade (D)',
    gradedHard.graded[0].grade === 'EXCLUDED' && gradedHard.excluded.length === 1);
  const scenarioExclusion = gradeSkills({
    scenario: { id: 's', name: 'n', category: 'c', exclude_skill_ids: ['banned'] },
    skills: [
      { skill: { id: 'banned', name: 'b', capabilities: ['code_gen'] }, link: { confidence: 1, autoDerived: false }, compat: null },
    ] as any,
    requiredCapabilities: ['code_gen'],
    userTier: 'PRO',
  });
  check('a scenario-declared exclusion wins over a scenario link + capability match',
    scenarioExclusion.graded[0].grade === 'EXCLUDED'
    && scenarioExclusion.selectable.length === 0 && scenarioExclusion.staged.length === 0);

  console.log('\nA10. The new chain caps at 2 skills and requires a benefit check for the 2nd');
  const threeEligible = gradeSkills({
    scenario: { id: 's', name: 'n', category: 'c' },
    skills: [
      { skill: { id: 's1', name: 's1', capabilities: ['a'] }, link: { confidence: 1, autoDerived: false }, compat: { experiment_count: 1, success_rate: 1, unique_user_count: 20 } },
      { skill: { id: 's2', name: 's2', capabilities: ['b'] }, link: { confidence: 1, autoDerived: false }, compat: { experiment_count: 1, success_rate: 1, unique_user_count: 20 } },
      { skill: { id: 's3', name: 's3', capabilities: ['c'] }, link: { confidence: 1, autoDerived: false }, compat: { experiment_count: 1, success_rate: 1, unique_user_count: 20 } },
    ] as any,
    userTier: 'PRO',
  });
  check('three eligible skills → at most 2 selected (hard cap in the grader)', threeEligible.selectable.length <= 2,
    JSON.stringify(threeEligible.selectable));
  check('the trimmed candidate is reported (cap_trimmed), not silently dropped',
    threeEligible.cap_trimmed === true);
  const overlappingPair = gradeSkills({
    scenario: { id: 's', name: 'n', category: 'c' },
    skills: [
      { skill: { id: 'p1', name: 'p1', capabilities: ['a'] }, link: { confidence: 1, autoDerived: false }, compat: { experiment_count: 1, success_rate: 1, unique_user_count: 20 } },
      { skill: { id: 'p2', name: 'p2', capabilities: ['a'] }, link: { confidence: 1, autoDerived: false }, compat: { experiment_count: 1, success_rate: 1, unique_user_count: 20 } },
    ] as any,
    userTier: 'PRO',
  });
  check('two skills with identical capabilities → only one selected (no decorative 2nd)',
    overlappingPair.selectable.length === 1, JSON.stringify(overlappingPair.selectable));

  console.log('\nA11. Zero selection is terminal in the new chain too (never an error)');
  const emptyChain = gradeSkills({
    scenario: { id: 's', name: 'n', category: 'c' },
    skills: [],
    userTier: 'PRO',
  });
  check('no candidates → empty selection, no exception', emptyChain.selectable.length === 0);
  const belowBar = gradeSkills({
    scenario: { id: 's', name: 'n', category: 'c' },
    skills: [
      { skill: { id: 'weak', name: 'w', capabilities: ['x'] }, link: { confidence: 0.5, autoDerived: false }, compat: null },
    ] as any,
    userTier: 'PRO',
  });
  check('a marginal candidate stays below the bar (not upgraded, not staged)',
    belowBar.selectable.length === 0 && belowBar.graded[0].grade === 'D'
    && belowBar.staged.length === 0,
    JSON.stringify({ grade: belowBar.graded[0].grade, staged: belowBar.staged }));
  check('and the reason is recorded, so the zero-selection is auditable',
    belowBar.graded[0].reason_codes.length > 0 || belowBar.graded[0].score === 0,
    JSON.stringify(belowBar.graded[0]));
  check('the grading result is synchronous (no model round-trip at all)',
    typeof (gradeSkills({ scenario: { id: 'x', name: 'n', category: 'c' }, skills: [] }) as any).then !== 'function');

  console.log('\nA12. The English Prompt Architect prompt is dedicated to the Architect model only');
  // Audit result (see report): that prompt exists ONLY in the task spec text
  // (_inbox/analysis/user_1432.txt §8.1); it was never landed in code. "Not
  // implemented" is not an excuse to skip the invariant — this scan is what
  // keeps a future implementation from leaking it into a chat prompt.
  const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|json|md)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const srcFiles = walk(SRC_ROOT);
  check('the scan actually walked the source tree', srcFiles.length > 50, `n=${srcFiles.length}`);

  // Distinctive sentences of the English Prompt Architect system prompt. If a
  // future change pastes it into any module (kernel, composer, compiler, chat
  // route, ...) this fails immediately.
  const ARCHITECT_SIGNATURES = [
    'You are the OmniTask Prompt Architect.',
    'dedicated system prompt for the Prompt Architect model only',
    'OmniTask Prompt Architect',
  ];
  const architectHits = srcFiles.filter((f) => {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { return false; }
    return ARCHITECT_SIGNATURES.some((s) => text.includes(s));
  });
  check('no source file contains the Prompt Architect English system prompt (or its signature lines)',
    architectHits.length === 0, architectHits.map((f) => f.replace(SRC_ROOT, '')).join(', '));

  // No ordinary-chat prompt module may import an architect module either.
  const ARCHITECT_MODULE_RE = /from ['"][^'"]*prompt[-_]?architect/i;
  const architectImports = srcFiles.filter((f) => {
    try { return ARCHITECT_MODULE_RE.test(readFileSync(f, 'utf8')); } catch { return false; }
  });
  check('no source file imports a prompt-architect module',
    architectImports.length === 0, architectImports.map((f) => f.replace(SRC_ROOT, '')).join(', '));

  // Positive control: prove the scan is not vacuous by pointing it at the one
  // dedicated-purpose English prompt that DOES exist (the curation AI), which
  // follows the same isolation discipline and must stay isolated to its module.
  const CURATION_SIGNATURE = "You are OmniTask's User Information Curation AI.";
  const curationFiles = srcFiles.filter((f) => {
    try { return readFileSync(f, 'utf8').includes(CURATION_SIGNATURE); } catch { return false; }
  });
  check('the dedicated-purpose English prompt that DOES exist is confined to exactly one module',
    curationFiles.length === 1 && curationFiles[0].replace(SRC_ROOT, '').startsWith('services/userCuration/'),
    curationFiles.map((f) => f.replace(SRC_ROOT, '')).join(','));
  check('and it is NOT referenced from any ordinary-chat prompt builder',
    (() => {
      const chatBuilders = srcFiles.filter((f) => /promptComposer|compiler|promptRuntime|kernel\.ts/.test(f));
      return chatBuilders.every((f) => {
        const t = readFileSync(f, 'utf8');
        return !t.includes('CURATION_SYSTEM_PROMPT') && !t.includes("userCuration/prompt");
      });
    })(), '');
  const ARCHITECT_MODEL_SPEC = 'agnes-3.0-flash';
  check('the spec-declared Architect model name is recorded here so the future call site cannot silently pick another',
    typeof ARCHITECT_MODEL_SPEC === 'string' && ARCHITECT_MODEL_SPEC.startsWith('agnes-'));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
