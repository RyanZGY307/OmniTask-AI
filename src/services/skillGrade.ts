// ================================================================
// Skill Grading — deterministic, zero-AI replacement for S2's per-Skill
// semantic judging.
// ================================================================
// 为什么取代 S2：S2 对每个候选 Skill 发一次 Agnes 调用让模型判断"语义上合
// 不合身"。按项目约定「能代码化就不用 AI」与用户明确的「严格零 AI：Skill 选择
// 只走确定性规则」，语义相似 ≠ 应该使用，这个判断完全可以用可审计的规则做出，
// 且规则可以验证、可以回归测试，模型调用不能。
//
// 优先级（从高到低，与技能选择规范一致）：
//   1. 绝不违反硬性规则（档位权限 / 生命周期 / 硬排除 / 版本兼容）——这些先
//      于任何评分，命中即 EXCLUDED，永不参选（防误选第一关）；
//   2. 宁缺毋滥：达不到明确适用门槛就不选（零选是正常终态）；
//   3. 最低延迟：只读已取回的候选与索引，不解析 Skill 正文，不发任何模型请求；
//   4. 第二个 Skill 必须通过额外互补收益检查，整条链上限 2；
//
// 分级（A/B/C/D 为适用性，EXCLUDED 为硬规则否决）：
//   A  明确适用，可被选中
//   B  证据良好但未达"明确"：只入观察，除非它是任务必需证据源
//   C  证据不足：只入观察（experiment），绝不自动选中
//   D  无正向证据
//   唯一例外是"任务必需证据源"（knowledge_base 在知识型任务上）：它有独立通道，
//   且仍要求至少有 C 级正向证据，不是无条件选。
//
// 双向指标：既监控"误选"（被硬门拦下、被上限截断、降级选中的次数），也监控
// "零选率"。只看调用率会逼着系统凑数，这正是规范禁止的。
// ================================================================

import type { S2CandidateSkill } from './scenarioWorkers/s2SkillJudge';

// ==================== 分级与门槛 ====================

/** 适用性分级；EXCLUDED 与 A/B/C/D 不同族——前者是硬规则否决，不是"分数低"。 */
export type SkillGrade = 'EXCLUDED' | 'A' | 'B' | 'C' | 'D';

/** A 级门槛：达到"明确适用、显然有益"。 */
export const GRADE_A_MIN_SCORE = 6;
/** B 级区间下限。 */
export const GRADE_B_MIN_SCORE = 4;
/** C 级区间下限（低于此即 D）。 */
export const GRADE_C_MIN_SCORE = 2;
/** 第二个 Skill 与主 Skill 的最大分差，超过即视为凑数。 */
export const SECOND_SKILL_MAX_GAP = 3;

/** 知识型任务类型：knowledge_base 在这些任务里是"任务必需证据源"。 */
export const KNOWLEDGE_TASK_TYPES = new Set(['research', 'analysis', 'planning', 'complex']);

/** 已被淘汰/弃用的生命周期状态，任何命中都不再参选。 */
const RETIRED_LIFECYCLES = new Set(['deprecated', 'retired', 'archived', 'sunset']);

// ==================== 输入 ====================

export interface SkillGradeScenario {
  id: string;
  name: string;
  category: string;
  signature?: string;
  /** 该场景声明的硬排除 Skill id 列表（绝对优先，即使同时被 Link 推荐） */
  exclude_skill_ids?: string[];
  /** 该场景要求的 Skill 版本（"1.x" 形式），不满足则降级/排除 */
  required_skill_version?: string;
}

export interface SkillGradeInput {
  scenario: SkillGradeScenario;
  skills: S2CandidateSkill[];
  userTier?: string;
  /** 来自确定性意图层的任务类型——不重复分析，不调模型 */
  taskType?: string;
  /** 意图层合并的必需能力 */
  requiredCapabilities?: string[];
  /** 用户原始消息（仅用于 trigger 命中这类弱证据） */
  message?: string;
  /** 场景级实验约束，如 ['skill<=2'] */
  experimentConstraints?: string[];
}

export interface GradedSkill {
  skill_id: string;
  grade: SkillGrade;
  score: number;
  reason_codes: string[];
  /** 命中哪条硬门（仅 EXCLUDED 有） */
  gate?: string;
  /** 与主 Skill 无重叠的能力（用于第二 Skill 互补收益检查） */
  capabilities: string[];
  /** 版本/适配档案 */
  profile?: { version?: string; adaptation: number; linked: boolean; link_confidence?: number };
  /**
   * 任务必需证据源（唯一允许 B/C 级被选中的例外）：knowledge_base 在知识型
   * 任务上不可缺失，且至少有 C 级正向证据。除此之外，低于 A 级绝不自动选中。
   */
  task_necessary?: boolean;
}

export interface SkillGradeOutput {
  scenario_id: string;
  graded: GradedSkill[];
  /** 允许被选中的 id，按证据强度降序；已应用硬门与上限 */
  selectable: string[];
  /** 仅入观察（C 级）或满足互补但未过门槛的 id */
  staged: string[];
  excluded: string[];
  /** 是否因上限截断过候选（误选监控信号） */
  cap_trimmed: boolean;
  metrics: SkillGradeMetrics;
}

// ==================== 指标（双向） ====================

export interface SkillGradeMetrics {
  graded: number;
  excluded_by_gate: number;
  grade_a: number;
  grade_b: number;
  grade_c: number;
  grade_d: number;
  selected: number;
  staged: number;
  /** 零选次数——必须被监控，且不得为了压低它而凑数 */
  zero_selections: number;
  /** 被上限截断的次数（本想多选而没能，误选风险信号） */
  cap_trimmed: number;
  /** 选中项里等级低于 A 的次数（降级选中，需人工复盘） */
  downgrade_selections: number;
  total_elapsed_ms: number;
}

const metrics: SkillGradeMetrics = {
  graded: 0, excluded_by_gate: 0, grade_a: 0, grade_b: 0, grade_c: 0, grade_d: 0,
  selected: 0, staged: 0, zero_selections: 0, cap_trimmed: 0, downgrade_selections: 0,
  total_elapsed_ms: 0,
};

export function getSkillGradeMetrics(): SkillGradeMetrics {
  return { ...metrics };
}

export function resetSkillGradeMetrics(): void {
  Object.assign(metrics, {
    graded: 0, excluded_by_gate: 0, grade_a: 0, grade_b: 0, grade_c: 0, grade_d: 0,
    selected: 0, staged: 0, zero_selections: 0, cap_trimmed: 0, downgrade_selections: 0,
    total_elapsed_ms: 0,
  });
}

// ==================== 按场景 ID 的 Skill 索引 ====================

export interface SkillScenarioIndex {
  scenario_id: string;
  /** 该场景链接到的 Skill，按 link.confidence 降序 */
  skill_ids: string[];
  by_skill: Record<string, { confidence: number; autoDerived: boolean }>;
}

/**
 * 由候选集构建「场景 id → Skills」索引。候选本身携带 SkillScenarioLink
 * （retrieveCandidateSkills 已按场景取回），所以这是零额外查询的纯函数；
 * 显式建成索引结构，是为了让"按场景 ID 命中"成为可测、可复用的一等信号。
 */
export function buildSkillScenarioIndex(
  scenarioId: string,
  skills: S2CandidateSkill[],
): SkillScenarioIndex {
  const by_skill: SkillScenarioIndex['by_skill'] = {};
  for (const c of skills) {
    if (!c.link) continue;
    by_skill[c.skill.id] = { confidence: c.link.confidence, autoDerived: !!c.link.autoDerived };
  }
  const skill_ids = Object.keys(by_skill).sort((a, b) => by_skill[b].confidence - by_skill[a].confidence);
  return { scenario_id: scenarioId, skill_ids, by_skill };
}

// ==================== 档位 ====================

const TIER_ORDER = ['FREE', 'STANDARD', 'PRO', 'ENTERPRISE'];
const TIER_ALIAS: Record<string, string> = { ULTRA: 'PRO', BASIC: 'FREE' };

function tierIdxOf(tier?: string): number {
  const t = TIER_ALIAS[(tier ?? 'STANDARD').toUpperCase()] ?? (tier ?? 'STANDARD').toUpperCase();
  const i = TIER_ORDER.indexOf(t);
  return i === -1 ? 0 : i;
}

function skillRequiredTier(skill: S2CandidateSkill['skill']): string {
  const anySkill = skill as any;
  return String(anySkill.requiredTier ?? anySkill.required_tier ?? 'STANDARD');
}

// ==================== 版本/适配档案 ====================

function readProfile(c: S2CandidateSkill, linked: boolean, linkConfidence?: number): GradedSkill['profile'] {
  const anySkill = c.skill as any;
  const compat = c.compat;
  // adaptation：历史成功率 × 覆盖度（样本不足时不给满分，避免 1 次成功当成普遍有效）
  const success = typeof compat?.success_rate === 'number' ? compat.success_rate : 0.5;
  const coverage = compat ? Math.min(1, (compat.unique_user_count ?? 0) / 10) : 0;
  const adaptation = +(success * (0.5 + 0.5 * coverage)).toFixed(3);
  return {
    version: anySkill.version ? String(anySkill.version) : undefined,
    adaptation,
    linked,
    link_confidence: linkConfidence,
  };
}

/** 版本适配加成：档案显示已被该场景适配过才是正向证据。 */
function adaptationBonus(profile?: GradedSkill['profile']): number {
  if (!profile) return 0;
  return profile.adaptation >= 0.6 ? 2 : 0;
}

// ==================== 主流程 ====================

/**
 * 对候选 Skill 分级。纯函数（除指标累计），无 I/O、无模型调用——同一输入必然
 * 得到同一输出，可回归测试。
 */
export function gradeSkills(input: SkillGradeInput): SkillGradeOutput {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const scenario = input.scenario;
  const userTierIdx = tierIdxOf(input.userTier);
  const hardExcluded = new Set((scenario.exclude_skill_ids ?? []).map(String));
  const taskType = input.taskType ?? '';
  const requiredCaps = new Set(input.requiredCapabilities ?? []);
  const message = (input.message ?? '').toLowerCase();
  const index = buildSkillScenarioIndex(scenario.id, input.skills);

  const graded: GradedSkill[] = input.skills.map((c) => {
    const id = c.skill.id;
    const reason: string[] = [];
    const profile = readProfile(c, !!c.link, c.link?.confidence);

    // —— 硬门：先于任何评分， cheapest first（fast-fail）——
    // 1) 档位权限。绝不让越权 Skill 参选——这是安全/权限规则，优先级最高。
    const reqTier = skillRequiredTier(c.skill);
    if (tierIdxOf(reqTier) > userTierIdx) {
      return { skill_id: id, grade: 'EXCLUDED', score: 0, reason_codes: ['tier'], gate: `tier:${reqTier}>${input.userTier ?? 'STANDARD'}`, capabilities: [], profile };
    }
    // 2) 场景硬排除。绝对优先：即使它同时被 Link 推荐、能力完全匹配，也不参选。
    if (hardExcluded.has(id)) {
      return { skill_id: id, grade: 'EXCLUDED', score: 0, reason_codes: ['hard_exclusion'], gate: 'scenario_exclude', capabilities: [], profile };
    }
    // 3) 生命周期淘汰。 deprecated/retired 的 Skill 不因历史数据好看而复活。
    if (c.compat && RETIRED_LIFECYCLES.has(String(c.compat.lifecycle).toLowerCase())) {
      return { skill_id: id, grade: 'EXCLUDED', score: 0, reason_codes: ['lifecycle'], gate: `lifecycle:${c.compat.lifecycle}`, capabilities: [], profile };
    }
    // 4) 版本不兼容。场景要求某版本而 Skill 不满足时不猜、不硬上。
    if (scenario.required_skill_version && profile?.version) {
      const want = scenario.required_skill_version.replace(/[^0-9.]/g, '');
      const have = profile.version.replace(/[^0-9.]/g, '');
      if (want && have && !have.startsWith(want.split('.')[0])) {
        return { skill_id: id, grade: 'EXCLUDED', score: 0, reason_codes: ['version'], gate: `version:${profile.version}!~${scenario.required_skill_version}`, capabilities: [], profile };
      }
    }

    // —— 证据计数（不是概率；每一项都可解释、可回归）——
    const caps = c.skill.capabilities ?? [];
    let score = 0;
    let triggerHits = 0;
    // triggers 不在 Skill 元数据接口里（S2CandidateSkill.skill 只保证 id/name/
    // description/capabilities/constraints）；检索层可能带上它，有则用作弱证据。
    const triggers: string[] = (c.skill as any).triggers ?? [];
    for (const t of triggers) {
      if (message.includes(String(t).toLowerCase())) triggerHits++;
    }
    if (triggerHits > 0) { score += Math.min(triggerHits, 2); reason.push(`trigger:${triggerHits}`); }

    // 按场景 ID 索引命中：该场景显式链接过这个 Skill——最强证据。
    const linkHit = index.by_skill[id];
    if (linkHit && linkHit.confidence >= 0.7) { score += 3; reason.push('scenario_index'); }
    else if (linkHit) { score += 1; reason.push('scenario_index_weak'); }

    // 任务类型能力匹配 / 意图层明确能力需求。
    for (const cap of caps) {
      if (requiredCaps.has(cap)) { score += 2; reason.push(`required_cap:${cap}`); break; }
    }
    // 历史证据：成功率与覆盖度都够才加分（单次成功不算证据）。
    if ((c.compat?.success_rate ?? 0) >= 0.7 && (c.compat?.unique_user_count ?? 0) >= 5) {
      score += 2; reason.push('history');
    }
    // knowledge_base 在知识型任务里是任务必需证据源。注意：必要性不给自己加分
    // ——必要性由下面的 task_necessary 标记表达，若同时再加分，零证据的 Skill 会
    // 被自己加的分推过门槛（循环论证）。
    const isKnowledge = id === 'knowledge_base';
    // 版本适配档案。
    const adapt = adaptationBonus(profile);
    if (adapt > 0) { score += adapt; reason.push('adapted'); }

    const grade: SkillGrade =
      score >= GRADE_A_MIN_SCORE ? 'A'
        : score >= GRADE_B_MIN_SCORE ? 'B'
          : score >= GRADE_C_MIN_SCORE ? 'C'
            : 'D';

    // 任务必需证据源：唯一允许低于 A 级被选中的通道。仍要求至少有 C 级"独立"
    // 正向证据——不是"无论有没有证据都选"。除此之外，B/C/D 一律只入观察。
    const task_necessary =
      isKnowledge && KNOWLEDGE_TASK_TYPES.has(taskType) && score >= GRADE_C_MIN_SCORE;
    if (task_necessary) reason.push('task_necessary');

    return {
      skill_id: id,
      grade,
      score,
      reason_codes: reason,
      capabilities: caps,
      profile,
      task_necessary,
    };
  });

  // —— 选择：只选 A，或 task_necessary；C/D/EXCLUDED 绝不选 ——
  // 第二个 Skill 默认不选：必须零能力重叠（互补）且分差不超过阈值（防凑数）。
  const eligible = graded
    .filter((g) => g.grade === 'A' || g.task_necessary === true)
    .sort((a, b) => b.score - a.score || a.skill_id.localeCompare(b.skill_id));

  const cap = skillCap(input.experimentConstraints);
  const capTrimmed = eligible.length > cap;

  const selected: GradedSkill[] = [];
  if (eligible.length > 0) selected.push(eligible[0]);
  if (eligible.length > 1 && cap >= 2) {
    const cand = eligible[1];
    const primaryCaps = new Set(selected[0].capabilities);
    const overlap = cand.capabilities.filter((c) => primaryCaps.has(c)).length;
    const complementary = overlap === 0 && cand.capabilities.some((c) => !primaryCaps.has(c));
    const notFiller = selected[0].score - cand.score <= SECOND_SKILL_MAX_GAP;
    if (complementary && notFiller) selected.push(cand);
  }

  const selectable = selected.map((g) => g.skill_id);
  const staged = graded
    .filter((g) => (g.grade === 'B' || g.grade === 'C') && !selectable.includes(g.skill_id))
    .map((g) => g.skill_id);
  const excluded = graded.filter((g) => g.grade === 'EXCLUDED').map((g) => g.skill_id);

  const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const elapsed = +(end - start).toFixed(3);

  // 指标累计（双向：误选信号 + 零选率）
  metrics.graded += graded.length;
  metrics.excluded_by_gate += excluded.length;
  for (const g of graded) {
    if (g.grade === 'A') metrics.grade_a++;
    else if (g.grade === 'B') metrics.grade_b++;
    else if (g.grade === 'C') metrics.grade_c++;
    else if (g.grade === 'D') metrics.grade_d++;
  }
  metrics.selected += selectable.length;
  metrics.staged += staged.length;
  if (selectable.length === 0) metrics.zero_selections++;
  if (capTrimmed) metrics.cap_trimmed++;
  // 选中项等级低于 A 的次数 = 降级选中，需复盘
  const selectedGrades = selectable.map((id) => graded.find((g) => g.skill_id === id)!.grade);
  metrics.downgrade_selections += selectedGrades.filter((g) => g !== 'A').length;
  metrics.total_elapsed_ms += elapsed;

  return {
    scenario_id: scenario.id,
    graded,
    selectable,
    staged,
    excluded,
    cap_trimmed: capTrimmed,
    metrics: getSkillGradeMetrics(),
  };
}

/** 解析 'skill<=N' / 'skills<=N' 约束；默认 2（执行链硬上限）。 */
export function skillCap(constraints?: string[]): number {
  for (const c of constraints ?? []) {
    const m = c.match(/skills?\s*<=?\s*(\d+)/i);
    if (m) return Math.max(0, parseInt(m[1], 10));
  }
  return 2;
}
