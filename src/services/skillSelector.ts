// ================================================================
// Skill Selector — 确定性快速选择器（零 AI 调用）
// ================================================================
// 设计目标（优先级从高到低）：
//   1. 不违反硬性排除规则（tier / 知识库场景限制）；
//   2. 宁缺毋滥：没有候选达到适用性门槛时立即 SELECT_NONE；
//   3. 最低延迟：只查模块加载时预计算的索引，不解析 Skill 正文，
//      不调用任何分类模型，不逐个评估全部 Skill；
//   4. 默认最多 1 个 Skill；第二个 Skill 必须通过额外互补收益检查；
//      整条链上限 2（注入层 buildSkillSections 再做一次硬截断兜底）。
//
// 说明：适用性分数是「证据计数」启发式（trigger 命中 / 任务类型能力
// 匹配 / 意图层 requiredCapabilities），不是校准过的概率。门槛可用
// CORTX_SKILL_MIN_SCORE 调整；调门槛要对照零选率/误选率指标（见
// getSkillSelectionMetrics），不得只看调用率。
// ================================================================

import { SKILLS } from './skills';

export type SkillDecision = 'SELECT_NONE' | 'SELECT_ONE' | 'SELECT_TWO';

export interface SkillSelectionResult {
  decision: SkillDecision;
  skillIds: string[];
  reason: string;
  elapsedMs: number;
  candidates: Array<{ id: string; score: number; excluded?: string }>;
}

// ==================== 可配置门槛 ====================

/** 最低适用性门槛：证据分低于此值的候选一律不选（默认 2 = 至少一个强信号） */
export const MIN_SCORE = Number(process.env.CORTX_SKILL_MIN_SCORE ?? 2);
/** 第二个 Skill 的最低证据分（须明显高于门槛，防止凑数） */
const SECOND_SKILL_MIN_SCORE = MIN_SCORE + 1;
/** 主/辅分差超过该值时，辅助 Skill 视为凑数 */
const SECOND_SKILL_MAX_GAP = 3;
/** 整条执行链的 Skill 硬上限（注入层会再次强制） */
export const SKILL_HARD_CAP = 2;

// ==================== 预计算索引（模块加载时一次） ====================

const TIER_ORDER = ['STANDARD', 'PRO']; // ULTRA 按 PRO 对待（已退役档）

/** knowledge_base 只在知识型任务或用户点名知识库时适用（沿用既有规则） */
const KNOWLEDGE_TASK_TYPES = new Set(['research', 'analysis', 'planning', 'complex']);

/** 任务类型 → 强相关能力（命中 +2） */
const TASK_CAPABILITY: Record<string, string> = {
  coding: 'code_gen',
  research: 'search',
  analysis: 'analysis',
  math: 'math',
  translation: 'translation',
  writing: 'writing',
};

interface IndexedSkill {
  id: string;
  triggers: string[];      // 已小写
  capabilities: Set<string>;
  requiredTier: string;
  tierIdx: number;
}

const INDEX: IndexedSkill[] = Object.values(SKILLS).map((s) => ({
  id: s.id,
  triggers: s.triggers.map((t) => t.toLowerCase()),
  capabilities: new Set(s.capabilities),
  requiredTier: s.requiredTier,
  tierIdx: s.requiredTier === 'ULTRA' ? 1 : TIER_ORDER.indexOf(s.requiredTier),
}));

// ==================== 指标（零选率/误选率监控的基础） ====================

const metrics = {
  selections: 0,
  zero: 0,
  one: 0,
  two: 0,
  totalElapsedMs: 0,
  lastReason: '' as string,
};

export function getSkillSelectionMetrics() {
  return { ...metrics, avgElapsedMs: metrics.selections ? +(metrics.totalElapsedMs / metrics.selections).toFixed(3) : 0 };
}

let metricsLoggedAt = 0;
function bumpMetrics(result: SkillSelectionResult) {
  metrics.selections++;
  metrics.totalElapsedMs += result.elapsedMs;
  metrics.lastReason = result.reason;
  if (result.decision === 'SELECT_NONE') metrics.zero++;
  else if (result.decision === 'SELECT_ONE') metrics.one++;
  else metrics.two++;
  // 每 100 次输出一行汇总，供观察零选率随门槛的变化
  if (metrics.selections - metricsLoggedAt >= 100) {
    metricsLoggedAt = metrics.selections;
    console.log(`[SkillSelect] n=${metrics.selections} none=${metrics.zero} one=${metrics.one} two=${metrics.two} avg=${(metrics.totalElapsedMs / metrics.selections).toFixed(3)}ms`);
  }
}

// ==================== 选择逻辑 ====================

export interface SkillSelectionInput {
  message: string;
  /** 来自现有意图分析（classifyTask）的任务类型 —— 不重复分析 */
  taskType: string;
  /** 意图层合并的必需能力（如 contextIntent.capabilityIntent） */
  requiredCapabilities?: string[];
  userTier: string;
}

function tierIdxOf(tier: string): number {
  return tier === 'ULTRA' ? 1 : TIER_ORDER.indexOf(tier);
}

export function selectSkills(input: SkillSelectionInput): SkillSelectionResult {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const lower = (input.message || '').toLowerCase();
  const userTierIdx = tierIdxOf(input.userTier || 'STANDARD');
  const taskCap = TASK_CAPABILITY[input.taskType];

  const candidates: SkillSelectionResult['candidates'] = [];

  for (const skill of INDEX) {
    // —— 硬性过滤（先于任何评分）——
    if (skill.tierIdx > userTierIdx) {
      candidates.push({ id: skill.id, score: 0, excluded: `tier:${skill.requiredTier}>${input.userTier || 'STANDARD'}` });
      continue;
    }
    if (skill.id === 'knowledge_base' && !KNOWLEDGE_TASK_TYPES.has(input.taskType) && !skill.triggers.some((t) => lower.includes(t))) {
      // 非知识型任务且用户未点名知识库 → 排除（沿用既有语义）
      candidates.push({ id: skill.id, score: 0, excluded: 'knowledge_task_mismatch' });
      continue;
    }

    // —— 适用性证据计数（不是概率）——
    let score = 0;
    let triggerHits = 0;
    for (const t of skill.triggers) {
      if (lower.includes(t)) triggerHits++;
    }
    score += Math.min(triggerHits, 3); // trigger 命中封顶 +3，防关键词堆叠
    if (taskCap && skill.capabilities.has(taskCap)) score += 2;
    if (skill.id === 'knowledge_base' && KNOWLEDGE_TASK_TYPES.has(input.taskType)) {
      score += 2; // 知识型任务需要知识参考，沿用 discoverSkills 的原语义
    }
    for (const cap of input.requiredCapabilities ?? []) {
      if (skill.capabilities.has(cap)) score += 2; // 意图层明确能力需求是强证据
    }

    candidates.push({ id: skill.id, score });
  }

  const scored = candidates
    .filter((c) => !c.excluded && c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  const finish = (decision: SkillDecision, skillIds: string[], reason: string): SkillSelectionResult => {
    const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const result: SkillSelectionResult = {
      decision, skillIds: skillIds.slice(0, SKILL_HARD_CAP), reason,
      elapsedMs: +(end - start).toFixed(3),
      candidates,
    };
    bumpMetrics(result);
    return result;
  };

  // —— 零选是正式决策结果：没有合格候选立即返回，不再翻找低质量候选 ——
  if (scored.length === 0) {
    return finish('SELECT_NONE', [], `no candidate >= ${MIN_SCORE} (taskType=${input.taskType})`);
  }

  const primary = scored[0];
  const primaryDef = SKILLS[primary.id];

  // —— 第二个 Skill：默认不选；只有明确互补收益才考虑 ——
  let second: { id: string; score: number } | null = null;
  if (scored.length > 1) {
    const cand = scored[1];
    const candDef = SKILLS[cand.id];
    const primaryCaps = new Set(primaryDef.capabilities);
    const overlap = candDef.capabilities.filter((c: string) => primaryCaps.has(c)).length;
    const complementary = overlap === 0
      && candDef.capabilities.some((c: string) => !primaryCaps.has(c));
    // 知识型任务中 knowledge_base 是「任务必需证据源」：它达到门槛且与主技能无能力重叠时
    // 允许双选，不受「第二技能须显著更强」防凑数门槛限制（主/辅分差仍需 ≤ 3）
    const strongEnough = cand.score >= SECOND_SKILL_MIN_SCORE
      || (cand.id === 'knowledge_base' && KNOWLEDGE_TASK_TYPES.has(input.taskType));
    const notFiller = primary.score - cand.score <= SECOND_SKILL_MAX_GAP;
    if (complementary && strongEnough && notFiller) {
      second = cand;
    }
  }

  if (second) {
    return finish('SELECT_TWO', [primary.id, second.id],
      `primary=${primary.id}(${primary.score}) + complementary=${second.id}(${second.score})`);
  }
  return finish('SELECT_ONE', [primary.id], `primary=${primary.id}(${primary.score}); others below bar`);
}
