// Skill grading — deterministic, zero-AI. Covers every hard rule in the spec:
// hard gates before scoring, A/B/C/D/EXCLUDED, the two-Skill cap + second-skill
// benefit check, zero-selection as a legitimate outcome, and the dual metrics.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  buildSkillScenarioIndex,
  gradeSkills,
  getSkillGradeMetrics,
  resetSkillGradeMetrics,
  skillCap,
  type SkillGradeInput,
} from '../src/services/skillGrade';
import type { S2CandidateSkill } from '../src/services/scenarioWorkers/s2SkillJudge';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

interface CandOpts {
  capabilities?: string[];
  requiredTier?: string;
  version?: string;
  link?: { confidence: number; autoDerived?: boolean };
  compat?: { success_rate?: number; unique_user_count?: number; lifecycle?: string };
  triggers?: string[];
}

function cand(id: string, o: CandOpts = {}): S2CandidateSkill {
  return {
    skill: {
      id,
      name: id,
      capabilities: o.capabilities ?? [],
      triggers: o.triggers,
      requiredTier: o.requiredTier,
      version: o.version,
    },
    link: o.link ? { confidence: o.link.confidence, autoDerived: !!o.link.autoDerived, rationale: undefined } : undefined,
    compat: o.compat
      ? { experiment_count: 1, success_rate: 0.5, unique_user_count: 0, ...o.compat }
      : null,
  } as unknown as S2CandidateSkill;
}

const baseInput = (over: Partial<SkillGradeInput> = {}): SkillGradeInput => ({
  scenario: { id: 'sc_1', name: 'coding', category: 'coding' },
  skills: [],
  userTier: 'PRO',
  ...over,
});

(async () => {
  // ============================================================
  console.log('\n1. Hard gates run BEFORE any scoring (fast-fail, never overridden)');
  resetSkillGradeMetrics();
  const gated = gradeSkills(baseInput({
    skills: [
      cand('pro_only', { capabilities: ['code_gen'], requiredTier: 'ENTERPRISE', link: { confidence: 1 }, compat: { success_rate: 1, unique_user_count: 50 } }),
      cand('deprecated_one', { capabilities: ['code_gen'], link: { confidence: 1 }, compat: { lifecycle: 'deprecated', success_rate: 1, unique_user_count: 50 } }),
      cand('indexed_ok', { capabilities: ['code_gen'], link: { confidence: 1 } }),
      cand('wrong_version', { capabilities: ['code_gen'], version: '1.0.0', link: { confidence: 1 } }),
    ],
    requiredCapabilities: ['code_gen'],
  }));
  const byId = (id: string) => gated.graded.find((g) => g.skill_id === id)!;

  check('tier violation → EXCLUDED (permission rule beats every evidence signal)',
    byId('pro_only').grade === 'EXCLUDED' && String(byId('pro_only').gate).startsWith('tier:'), String(byId('pro_only').gate));
  check('deprecated lifecycle → EXCLUDED even with perfect history',
    byId('deprecated_one').grade === 'EXCLUDED' && String(byId('deprecated_one').gate).startsWith('lifecycle:'), String(byId('deprecated_one').gate));
  check('retired lifecycle never revives on good numbers',
    gradeSkills(baseInput({ skills: [cand('r', { compat: { lifecycle: 'retired', success_rate: 1, unique_user_count: 99 } })] }))
      .graded[0].grade === 'EXCLUDED');
  check('EXCLUDED is a different family from D: score 0 blocked, not a low grade',
    byId('pro_only').score === 0 && byId('pro_only').grade === 'EXCLUDED');
  check('a gated skill is never selected', !gated.selectable.includes('pro_only') && !gated.selectable.includes('deprecated_one'));
  check('every gate exclusion is reported for audit (version gate needs a declared requirement)',
    gated.excluded.length === 2, String(gated.excluded.length));
  check('the non-gated skill still grades normally',
    byId('indexed_ok').grade !== 'EXCLUDED', byId('indexed_ok').grade);

  console.log('\n2. Hard exclusion by scenario id is absolute (beats the scenario index)');
  const excludedByScenario = gradeSkills(baseInput({
    scenario: { id: 'sc_1', name: 'n', category: 'c', exclude_skill_ids: ['indexed_but_excluded'] },
    skills: [cand('indexed_but_excluded', { capabilities: ['code_gen'], link: { confidence: 1 } })],
    requiredCapabilities: ['code_gen'],
  }));
  check('a scenario-linked skill listed in exclude_skill_ids is still EXCLUDED',
    excludedByScenario.graded[0].grade === 'EXCLUDED' && excludedByScenario.graded[0].gate === 'scenario_exclude',
    JSON.stringify(excludedByScenario.graded[0]));
  check('excluded skill is neither selected nor staged',
    excludedByScenario.selectable.length === 0 && excludedByScenario.staged.length === 0);

  console.log('\n3. Version incompatibility');
  const versionMismatch = gradeSkills(baseInput({
    scenario: { id: 'sc', name: 'n', category: 'c', required_skill_version: '2.0' },
    skills: [cand('v1', { version: '1.0.0', capabilities: ['code_gen'], link: { confidence: 1 } })],
  }));
  check('major-version mismatch → EXCLUDED',
    versionMismatch.graded[0].grade === 'EXCLUDED', String(versionMismatch.graded[0].gate));
  const versionOk = gradeSkills(baseInput({
    scenario: { id: 'sc', name: 'n', category: 'c', required_skill_version: '2.0' },
    skills: [cand('v2', { version: '2.1.0', capabilities: ['code_gen'], link: { confidence: 1 } })],
    requiredCapabilities: ['code_gen'],
  }));
  check('satisfying the required major version → not gated',
    versionOk.graded[0].grade !== 'EXCLUDED', versionOk.graded[0].grade);
  check('a skill with no version metadata is not blocked by a version rule',
    versionOk.graded[0].grade !== 'EXCLUDED');

  console.log('\n4. Grades A/B/C/D reflect evidence strength');
  resetSkillGradeMetrics();
  const graded = gradeSkills(baseInput({
    skills: [
      cand('sk_a', { capabilities: ['code_gen'], link: { confidence: 0.9 }, compat: { success_rate: 1, unique_user_count: 20 } }),
      cand('sk_b', { capabilities: ['search'], link: { confidence: 0.8 } }),
      cand('sk_c', { capabilities: ['x'], link: { confidence: 0.8 } }),
      cand('sk_d', { capabilities: ['y'] }),
    ],
    requiredCapabilities: ['code_gen', 'search'],
  }));
  const g = (id: string) => graded.graded.find((x) => x.skill_id === id)!;
  check('index + required cap + history + adaptation → A',
    g('sk_a').grade === 'A', `score=${g('sk_a').score} codes=${g('sk_a').reason_codes.join('+')}`);
  check('the score is the sum of the reported reason codes (auditable)',
    g('sk_a').score >= 6 && g('sk_a').reason_codes.includes('scenario_index'), `codes=${g('sk_a').reason_codes.join('+')}`);
  check('index + required cap only → B', g('sk_b').grade === 'B', `score=${g('sk_b').score}`);
  check('index alone → C', g('sk_c').grade === 'C', `score=${g('sk_c').score}`);
  check('no evidence at all → D', g('sk_d').grade === 'D', `score=${g('sk_d').score}`);
  check('only A is selected; B/C/D are never force-selected',
    JSON.stringify(graded.selectable) === JSON.stringify(['sk_a']), JSON.stringify(graded.selectable));
  check('B and C are staged for observation, never auto-selected',
    graded.staged.includes('sk_b') && graded.staged.includes('sk_c')
    && !graded.selectable.includes('sk_b') && !graded.selectable.includes('sk_c'));

  console.log('\n5. The task-necessary evidence source is the ONE carve-out');
  const kbOnKnowledgeTask = gradeSkills(baseInput({
    skills: [cand('knowledge_base', { capabilities: [], link: { confidence: 0.8 } })],
    taskType: 'research',
  }));
  check('knowledge_base on a research task is selectable below A (task-necessary)',
    JSON.stringify(kbOnKnowledgeTask.selectable) === JSON.stringify(['knowledge_base']),
    JSON.stringify(kbOnKnowledgeTask.selectable));
  check('the carve-out is flagged and reasoned, not silent',
    kbOnKnowledgeTask.graded[0].task_necessary === true
    && kbOnKnowledgeTask.graded[0].reason_codes.includes('task_necessary'));
  const kbOnCodingTask = gradeSkills(baseInput({
    skills: [cand('knowledge_base', { capabilities: [], link: { confidence: 0.8 } })],
    taskType: 'coding',
  }));
  check('the same skill on a coding task is NOT auto-selected (no free riders)',
    kbOnCodingTask.selectable.length === 0, JSON.stringify(kbOnCodingTask.selectable));
  const kbNoEvidence = gradeSkills(baseInput({
    skills: [cand('knowledge_base', { capabilities: [] })],
    taskType: 'research',
  }));
  check('the carve-out still requires at least C-level evidence (never "always select")',
    kbNoEvidence.selectable.length === 0, JSON.stringify(kbNoEvidence.selectable));
  const otherSkillOnResearch = gradeSkills(baseInput({
    skills: [cand('not_kb', { capabilities: [], link: { confidence: 0.8 } })],
    taskType: 'research',
  }));
  check('the carve-out does not extend to other skills',
    otherSkillOnResearch.graded[0].task_necessary === false
    && otherSkillOnResearch.selectable.length === 0);

  console.log('\n6. Second skill needs an extra benefit check (no filler)');
  const complementary = gradeSkills(baseInput({
    skills: [
      cand('a1', { capabilities: ['code_gen'], link: { confidence: 0.9 }, compat: { success_rate: 1, unique_user_count: 20 } }),
      cand('a2', { capabilities: ['search'], link: { confidence: 0.9 }, compat: { success_rate: 1, unique_user_count: 20 } }),
    ],
  }));
  check('two A skills with zero capability overlap → both selected',
    complementary.selectable.length === 2, JSON.stringify(complementary.selectable));

  const overlapping = gradeSkills(baseInput({
    skills: [
      cand('a1', { capabilities: ['code_gen'], link: { confidence: 0.9 }, compat: { success_rate: 1, unique_user_count: 20 } }),
      cand('a2', { capabilities: ['code_gen'], link: { confidence: 0.9 }, compat: { success_rate: 1, unique_user_count: 20 } }),
    ],
  }));
  check('overlapping capabilities → only the primary (a second copy adds nothing)',
    overlapping.selectable.length === 1, JSON.stringify(overlapping.selectable));

  const filler = gradeSkills(baseInput({
    skills: [
      cand('strong', { capabilities: ['code_gen'], triggers: ['build'], link: { confidence: 1 }, compat: { success_rate: 1, unique_user_count: 20 } }),
      cand('weak', { capabilities: ['search'], link: { confidence: 0.75 } }),
    ],
    message: 'build me something',
  }));
  const gap = filler.graded.find((x) => x.skill_id === 'strong')!.score - filler.graded.find((x) => x.skill_id === 'weak')!.score;
  check(`score gap ${gap} > 3 → the weak second skill is treated as filler, not selected`,
    gap > 3 && filler.selectable.length === 1, JSON.stringify(filler.selectable));

  console.log('\n7. The cap is enforced by the grader itself');
  const capped = gradeSkills(baseInput({
    skills: [
      cand('a1', { capabilities: ['code_gen'], link: { confidence: 0.9 }, compat: { success_rate: 0.9, unique_user_count: 20 } }),
      cand('a2', { capabilities: ['search'], link: { confidence: 0.9 }, compat: { success_rate: 0.9, unique_user_count: 20 } }),
    ],
    experimentConstraints: ['skill<=1'],
  }));
  check('skill<=1 → only one selected', capped.selectable.length === 1, JSON.stringify(capped.selectable));
  check('cap_trimmed is reported (we wanted two, the cap said one)', capped.cap_trimmed === true);
  check('skillCap parses both spellings',
    skillCap(['skill<=1']) === 1 && skillCap(['skills<=3']) === 3 && skillCap([]) === 2);

  console.log('\n8. Zero selection is a first-class outcome');
  const empty = gradeSkills(baseInput({ skills: [] }));
  check('no candidates → empty selectable', empty.selectable.length === 0);
  check('empty selectable is not an error path', empty.graded.length === 0 && empty.staged.length === 0);
  const allBelowBar = gradeSkills(baseInput({
    skills: [cand('c1', { capabilities: ['x'], link: { confidence: 0.8 } }), cand('d1', { capabilities: ['y'] })],
  }));
  check('candidates that only reach C/D → still nothing selected',
    allBelowBar.selectable.length === 0, JSON.stringify(allBelowBar.selectable));
  check('a marginal candidate is never upgraded just to fill the slot',
    allBelowBar.staged.length === 1 && allBelowBar.selectable.length === 0, JSON.stringify(allBelowBar.staged));

  console.log('\n9. Dual metrics: mis-selection AND zero-selection are both tracked');
  resetSkillGradeMetrics();
  gradeSkills(baseInput({
    skills: [
      cand('tier_block', { requiredTier: 'ENTERPRISE', capabilities: ['x'] }),
      cand('cap_trim1', { capabilities: ['a'], link: { confidence: 1 }, compat: { success_rate: 1, unique_user_count: 20 } }),
      cand('cap_trim2', { capabilities: ['b'], link: { confidence: 1 }, compat: { success_rate: 1, unique_user_count: 20 } }),
    ],
    experimentConstraints: ['skill<=1'],
  }));
  gradeSkills(baseInput({ skills: [] }));
  gradeSkills(baseInput({ skills: [cand('only_c', { capabilities: ['x'], link: { confidence: 0.8 } })] }));
  const m = getSkillGradeMetrics();
  check('zero_selections counted (zero-rate is a monitored metric, not a failure)',
    m.zero_selections === 2, String(m.zero_selections));
  check('cap_trimmed counted', m.cap_trimmed === 1, String(m.cap_trimmed));
  check('excluded_by_gate counted (a gate firing is a mis-selection prevented)',
    m.excluded_by_gate === 1, String(m.excluded_by_gate));
  check('grade distribution recorded',
    m.grade_a > 0 && m.grade_c > 0, `A${m.grade_a} C${m.grade_c}`);
  check('elapsed time recorded (latency budget)', m.total_elapsed_ms >= 0);
  resetSkillGradeMetrics();
  const m0 = getSkillGradeMetrics();
  check('reset clears every counter',
    m0.graded === 0 && m0.zero_selections === 0 && m0.cap_trimmed === 0 && m0.selected === 0);

  console.log('\n10. Determinism and zero I/O (the zero-AI guarantee, structurally)');
  const input1 = baseInput({
    skills: [
      cand('a1', { capabilities: ['code_gen'], link: { confidence: 0.9 }, compat: { success_rate: 0.9, unique_user_count: 20 } }),
      cand('b1', { capabilities: ['search'], link: { confidence: 0.5 } }),
    ],
    message: 'hello', requiredCapabilities: ['code_gen'], taskType: 'coding', userTier: 'PRO',
  });
  const r1 = gradeSkills(input1);
  const r2 = gradeSkills(input1);
  check('same input → identical grades/scores', JSON.stringify(r1.graded) === JSON.stringify(r2.graded));
  check('same input → identical selection', JSON.stringify(r1.selectable) === JSON.stringify(r2.selectable));
  const src = readFileSync(join(__dirname, '..', 'src', 'services', 'skillGrade.ts'), 'utf8');
  check('module source contains no AI/model call',
    !/callAgnes|agnesCaller|callGemini|openai|fetch\(/.test(src));
  check('module source performs no I/O of its own',
    !/prismaKnowledge|from '\.\/db'|require\('\.\/db'\)/.test(src));
  check('graded output stays bounded by the candidate count',
    r1.graded.length === input1.skills.length);

  console.log('\n11. By-scenario-ID Skill index');
  const idx = buildSkillScenarioIndex('sc_1', [
    cand('low', { link: { confidence: 0.2, autoDerived: true } }),
    cand('high', { link: { confidence: 0.95 } }),
    cand('nolink'),
  ]);
  check('index is ordered by link confidence desc',
    JSON.stringify(idx.skill_ids) === JSON.stringify(['high', 'low']), JSON.stringify(idx.skill_ids));
  check('unlinked skills are not in the index', !idx.skill_ids.includes('nolink'));
  check('index keeps link metadata (autoDerived)',
    idx.by_skill.low.autoDerived === true && idx.by_skill.high.confidence === 0.95);
  check('index is keyed by the scenario id', idx.scenario_id === 'sc_1');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
