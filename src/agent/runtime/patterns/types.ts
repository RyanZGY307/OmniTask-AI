// Agent 架构模式层（2026-10-22 用户需求：Free 3 个 / Pro 7 个，按需切换）
// 模式 = 控制流形态（正交于深度档 D1/D2/D3：深度管开销，模式管编排）。
// 档位门禁在服务端 subscriptionTier（前端字段忽略，security §8）。
export const PATTERN_IDS = ['single_agent', 'react', 'plan_execute', 'multi_agent', 'route_skill', 'blackboard', 'graph_workflow'] as const;
export type PatternId = (typeof PATTERN_IDS)[number];
export type Tier = 'free' | 'pro';

export interface PatternSpec {
  id: PatternId;
  label: string;
  minTier: Tier;                    // 'free' = 免费版可用
  summary: string;                  // 何时用（选择依据）
  defaultDepth: 'd1' | 'd2' | 'd3';
  features: { explicitPlan: boolean; toolLoop: boolean; delegation: boolean; sharedMemory: boolean; dag: boolean; routing: boolean };
}

export const FREE_PATTERNS: readonly PatternId[] = ['single_agent', 'react', 'plan_execute'];

export const PATTERNS: Record<PatternId, PatternSpec> = {
  single_agent: { id: 'single_agent', label: '单 Agent', minTier: 'free', summary: '单步可答/单文件小改/只读查询——最低开销', defaultDepth: 'd1', features: { explicitPlan: false, toolLoop: true, delegation: false, sharedMemory: false, dag: false, routing: false } },
  react: { id: 'react', label: 'ReAct', minTier: 'free', summary: '需要思考-行动迭代的任务：多文件/中复杂度/工具多步', defaultDepth: 'd2', features: { explicitPlan: false, toolLoop: true, delegation: false, sharedMemory: false, dag: false, routing: false } },
  plan_execute: { id: 'plan_execute', label: 'Plan+Execute', minTier: 'free', summary: '步骤多/依赖明确/需展示计划与 verifier 复核', defaultDepth: 'd3', features: { explicitPlan: true, toolLoop: true, delegation: false, sharedMemory: false, dag: false, routing: false } },
  multi_agent: { id: 'multi_agent', label: 'Multi-Agent', minTier: 'pro', summary: '可分解为多个独立子任务的较大范围工作（并行派发）', defaultDepth: 'd3', features: { explicitPlan: true, toolLoop: true, delegation: true, sharedMemory: false, dag: false, routing: false } },
  route_skill: { id: 'route_skill', label: 'Route+Skill', minTier: 'pro', summary: '存在明确的技能/专业档案匹配，路由后按档案执行', defaultDepth: 'd2', features: { explicitPlan: false, toolLoop: true, delegation: false, sharedMemory: false, dag: false, routing: true } },
  blackboard: { id: 'blackboard', label: 'Blackboard', minTier: 'pro', summary: '多视角收敛/约束冲突需反复修订（共享黑板+控制循环）', defaultDepth: 'd3', features: { explicitPlan: true, toolLoop: true, delegation: false, sharedMemory: true, dag: false, routing: false } },
  graph_workflow: { id: 'graph_workflow', label: 'Graph Workflow', minTier: 'pro', summary: '显式条件分支/有向无环流程（审批门/多路径验证）', defaultDepth: 'd3', features: { explicitPlan: true, toolLoop: true, delegation: false, sharedMemory: false, dag: true, routing: false } },
};

/** Pro→Free 降级的最近免费模式（档位门禁触发时） */
export const PRO_TO_FREE_FALLBACK: Record<string, PatternId> = {
  multi_agent: 'plan_execute',    // 分解→串行计划
  route_skill: 'react',           // 路由→直接迭代
  blackboard: 'react',            // 多视角→单线迭代
  graph_workflow: 'plan_execute', // DAG→顺序计划
};

/** 复杂度信号（adaptive-execution §2 七因子，0-3 分制） */
export interface ComplexitySignals {
  dependencyDepth: number; goalAmbiguity: number; riskSideEffect: number;
  irreversibility: number; externalToolNeed: number; recoveryCost: number; verifiability: number;
}

export function scoreOf(s: ComplexitySignals): number {
  return s.dependencyDepth + s.goalAmbiguity + s.riskSideEffect + s.irreversibility + s.externalToolNeed + s.recoveryCost + s.verifiability;
}

export interface PatternSelectionInput {
  tier: Tier;
  signals: ComplexitySignals;
  requested?: PatternId;           // 用户/任务显式指定
  featureHints?: Partial<{ decomposable: boolean; skillMatch: boolean; multiPerspective: boolean; conditionalFlow: boolean }>;
}

export interface PatternSelection {
  pattern: PatternId;
  reason: string;
  requested?: PatternId;
  downgraded?: { from: PatternId; to: PatternId; why: string };
  depth: 'd1' | 'd2' | 'd3';
}

/** 免费档可用性（服务端判定） */
export function isPatternAllowed(id: PatternId, tier: Tier): boolean {
  return PATTERNS[id].minTier === 'free' || tier === 'pro';
}

/**
 * 模式选择（确定性启发式；非关键词匹配）：
 *  分数≤5 → single_agent；6-12 → react（有 skillMatch→route_skill 上限）；≥13 → plan_execute
 *  Pro 档按 featureHints 升到对应重模式；Free 档只允许 FREE_PATTERNS。
 */
export function selectPattern(input: PatternSelectionInput): PatternSelection {
  const { tier, signals, requested, hints } = normalize(input);
  const score = scoreOf(signals);
  let pick: PatternId;
  let reason: string;

  if (requested) {
    pick = requested;
    reason = '用户/任务显式指定';
  } else if (score >= 13) {
    pick = 'plan_execute';
    reason = `复杂度分 ${score}≥13（依赖深/目标不确定/风险或可逆性信号）`;
  } else if (score >= 6) {
    pick = 'react';
    reason = `复杂度分 ${score}∈[6,13]，需思考-行动迭代`;
  } else {
    pick = 'single_agent';
    reason = `复杂度分 ${score}≤5，单线可完成`;
  }

  // Pro 档特征升级（仅在未显式指定时）
  if (!requested && tier === 'pro') {
    if (hints.conditionalFlow) { pick = 'graph_workflow'; reason = '存在显式条件分支/门控'; }
    else if (hints.multiPerspective) { pick = 'blackboard'; reason = '多视角约束收敛'; }
    else if (hints.decomposable) { pick = 'multi_agent'; reason = '任务可分解并行'; }
    else if (hints.skillMatch && pick === 'react') { pick = 'route_skill'; reason = '存在技能/档案匹配'; }
  }

  const depth = PATTERNS[pick].defaultDepth;

  // 档位门禁：不允许→降级到最近免费模式并记录
  if (!isPatternAllowed(pick, tier)) {
    const to = PRO_TO_FREE_FALLBACK[pick] ?? 'react';
    return {
      pattern: to, requested, downgraded: { from: pick, to, why: `${pick} 为 Pro 档模式；免费档按最近等价降级` },
      reason: `档位门禁：${PATTERNS[to].label}（原 ${PATTERNS[pick].label} 需 Pro）`,
      depth: PATTERNS[to].defaultDepth,
    };
  }
  return { pattern: pick, reason, requested, depth };
}

function normalize(input: PatternSelectionInput): { tier: Tier; signals: ComplexitySignals; requested?: PatternId; hints: Required<NonNullable<PatternSelectionInput['featureHints']>> } {
  return {
    tier: input.tier,
    signals: input.signals,
    requested: input.requested,
    hints: { decomposable: false, skillMatch: false, multiPerspective: false, conditionalFlow: false, ...(input.featureHints ?? {}) },
  };
}
