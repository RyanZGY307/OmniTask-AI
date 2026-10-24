// ================================================================
// Generation Profile + Dynamic Temperature Engine
// ================================================================
// Temperature is NOT fixed. It is computed from:
//   Task + Context + Creativity + Accuracy + Exploration +
//   Diversity + Structure + Risk + Verification + Target Model
// ================================================================

// ================================================================
// 纯度说明（本次重构，原因见 test/temperatureEngine.test.ts）
//   原先本文件顶部 `import { getDynamicModels } from './configSync'`，
//   而 configSync 会在模块加载时实例化 Prisma 客户端。后果：
//     · 引入本模块 = 引入数据库连接副作用（DB 未配置时满屏 [DB] 噪音）
//     · computeTemperature 因读取模块级缓存而**不是纯函数**：
//       同一输入在缓存未就绪/重启前后可能给出不同温度
//     · 校准表 TEMP_CALIBRATION 未导出，无法独立测试与审查
//   现改为「依赖注入」：模型元数据由调用方在启动时注入，
//   未注入时不做模型夹取（与原先「查不到模型条目时原样返回」一致，
//   不是行为破坏）。
// ================================================================

/** 模型质量档位（用于温度上限）与速度档位（用于温度下限）。 */
export interface TemperatureModelMeta {
  qualityProfile?: number;
  speedProfile?: number;
}

/** 解析器：调用方注入；返回 null 表示该模型无档位信息。 */
export type TemperatureModelResolver = (modelKey: string) => TemperatureModelMeta | null | undefined;

let modelResolver: TemperatureModelResolver | null = null;

/**
 * 启动时注入模型档位解析器。由已加载 configSync 的调用方（chat.ts /
 * promptRuntime.ts）调用一次，避免本模块直接依赖数据库层。
 */
export function setTemperatureModelResolver(fn: TemperatureModelResolver | null): void {
  modelResolver = fn;
}

/** 当前是否已注入解析器（供测试与诊断）。 */
export function hasTemperatureModelResolver(): boolean {
  return modelResolver !== null;
}

export interface GenerationProfile {
  generation_mode: 'deterministic' | 'balanced' | 'creative' | 'exploratory';
  temperature: number;
  top_p?: number;
  max_tokens?: number;
  accuracy_target: number; // 0-1
  creativity_score: number; // 0-5
  exploration_score: number; // 0-1
  structure_score: number; // 0-1
  consistency_score: number; // 0-1
  diversity_score: number; // 0-1
  determinism_score: number; // 0-1
  risk_level: string;
  verification_level: string;
  retry_strategy?: 'none' | 'single' | 'adaptive' | 'multi';
}

// ==================== Calibration Table ====================
// Initial reference (NOT fixed binding to scenario)

/** 任务类型 → 温度区间 [min, max]。导出以便独立测试与人工审查。 */
export const TEMP_CALIBRATION: Record<string, [number, number]> = {
  calculation: [0.10, 0.30],
  mathematical_reasoning: [0.10, 0.30],
  fact_check: [0.15, 0.35],
  verification: [0.15, 0.35],
  compliance_check: [0.15, 0.30],
  consistency_check: [0.15, 0.30],
  code_debugging: [0.15, 0.35],
  code_review: [0.20, 0.45],
  code_optimization: [0.20, 0.45],
  diagnosis: [0.15, 0.40],
  troubleshooting: [0.20, 0.50],
  data_validation: [0.15, 0.40],
  quality_control: [0.15, 0.40],
  translation: [0.15, 0.40],
  formatting: [0.10, 0.30],
  extraction: [0.15, 0.40],
  classification: [0.15, 0.40],
  current_information: [0.20, 0.45],
  technical_writing: [0.30, 0.60],
  explanation: [0.30, 0.60],
  definition: [0.25, 0.50],
  why: [0.30, 0.60],
  how: [0.30, 0.60],
  data_analysis: [0.30, 0.55],
  scenario_analysis: [0.30, 0.55],
  risk_analysis: [0.30, 0.55],
  feasibility_analysis: [0.30, 0.55],
  root_cause_analysis: [0.30, 0.55],
  impact_analysis: [0.30, 0.55],
  comparison: [0.40, 0.75],
  tradeoff_analysis: [0.40, 0.75],
  pros_cons: [0.40, 0.75],
  suitability_analysis: [0.40, 0.75],
  requirement_matching: [0.40, 0.70],
  ranking_request: [0.40, 0.70],
  prioritization: [0.40, 0.70],
  selection: [0.40, 0.70],
  optimization: [0.40, 0.70],
  improvement: [0.40, 0.70],
  recommendation: [0.50, 0.90],
  personalized_recommendation: [0.55, 1.00],
  decision_support: [0.45, 0.80],
  alternative_generation: [0.60, 1.00],
  multi_option: [0.70, 1.20],
  planning: [0.40, 0.75],
  strategy: [0.40, 0.80],
  brainstorming: [1.00, 1.50],
  ideation: [1.00, 1.50],
  naming: [0.80, 1.30],
  concept_generation: [1.00, 1.50],
  design_generation: [1.00, 1.60],
  creative_writing: [1.10, 1.70],
  rewriting: [0.80, 1.40],
  polishing: [0.60, 1.00],
  expansion: [0.70, 1.20],
  compression: [0.30, 0.55],
  summarization: [0.30, 0.55],
  research: [0.30, 0.60],
  deep_research: [0.30, 0.55],
  synthesis: [0.40, 0.70],
  code_generation: [0.30, 0.60],
  code_explanation: [0.30, 0.55],
  code_refactoring: [0.30, 0.55],
  architecture_analysis: [0.30, 0.55],
  file_analysis: [0.30, 0.55],
  document_analysis: [0.30, 0.55],
  image_analysis: [0.30, 0.55],
  video_analysis: [0.30, 0.55],
  simulation: [0.40, 0.70],
  specification_generation: [0.30, 0.55],
  checklist_generation: [0.25, 0.50],
  template_generation: [0.30, 0.55],
  workflow_generation: [0.35, 0.65],
  instruction_generation: [0.30, 0.55],
  conversion: [0.20, 0.45],
  source_fidelity: [0.15, 0.40],
  answer: [0.40, 0.75],
  evaluation: [0.35, 0.65],
  tutoring: [0.45, 0.80],
  learning: [0.45, 0.80],
  practice: [0.40, 0.70],
  correction: [0.25, 0.50],
  localization: [0.30, 0.55],
};

const DEFAULT_RANGE: [number, number] = [0.40, 0.75];

// ==================== Temperature Engine ====================

export interface TemperatureInput {
  tasks: string[];
  creativity: number; // 0-5
  accuracy: string; // low|medium|high|critical
  exploration?: number; // 0-1
  diversity?: number; // 0-1
  structure?: number; // 0-1
  consistency?: number; // 0-1
  risk?: string;
  verification?: boolean;
  targetModel?: string;
}

export function computeTemperature(input: TemperatureInput): GenerationProfile {
  const { tasks, creativity, accuracy, exploration = 0.5, diversity = 0.5, structure = 0.5, consistency = 0.5, risk, verification, targetModel } = input;

  // 1. Get base range from primary task
  const primaryTask = tasks[0] || 'answer';
  const [minT, maxT] = TEMP_CALIBRATION[primaryTask] || DEFAULT_RANGE;

  // 2. Map accuracy to a bias
  const accuracyBias: Record<string, number> = {
    low: 0.05,
    medium: 0,
    high: -0.10,
    critical: -0.20,
  };
  const aBias = accuracyBias[accuracy] || 0;

  // 3. Map creativity (0-5) to temperature multiplier
  //    0 → pull down toward min; 5 → pull up toward max
  const creativityFactor = creativity / 5; // 0..1
  const base = minT + (maxT - minT) * creativityFactor;

  // 4. Modulate by exploration and diversity (higher → more temp)
  const explorationBoost = exploration * 0.15;
  const diversityBoost = diversity * 0.10;

  // 5. Modulate by structure and consistency (higher → lower temp)
  const structureDampen = structure * 0.10;
  const consistencyDampen = consistency * 0.08;

  // 6. Modulate by risk
  const riskBias: Record<string, number> = {
    none: 0,
    low: 0,
    medium: -0.05,
    high: -0.10,
    critical: -0.20,
  };
  const rBias = riskBias[risk || 'none'] || 0;

  // 7. Verification lowers temperature
  const vBias = verification ? -0.08 : 0;

  // 8. Combine
  let temp = base + aBias + explorationBoost + diversityBoost - structureDampen - consistencyDampen + rBias + vBias;

  // 9. Clamp to [minT - 0.10, maxT + 0.20] (allow slight overshoot for creative)
  const floor = Math.max(0.05, minT - 0.10);
  const ceiling = Math.min(2.0, maxT + 0.20);
  temp = Math.max(floor, Math.min(ceiling, temp));

  // 10. Target model capability constraint
  if (targetModel) {
    temp = clampForModel(temp, targetModel);
  }

  // 11. Round to 2 decimal places
  temp = Math.round(temp * 100) / 100;

  // 12. Determine generation mode
  let generation_mode: GenerationProfile['generation_mode'] = 'balanced';
  if (temp <= 0.30) generation_mode = 'deterministic';
  else if (temp >= 1.00) generation_mode = 'exploratory';
  else if (creativity >= 4) generation_mode = 'creative';

  // 13. Retry strategy
  let retry_strategy: GenerationProfile['retry_strategy'] = 'none';
  if (verification) retry_strategy = 'adaptive';
  if (accuracy === 'critical' || risk === 'critical') retry_strategy = 'multi';

  return {
    generation_mode,
    temperature: temp,
    top_p: temp > 0.8 ? 0.95 : 0.90,
    accuracy_target: accuracy === 'critical' ? 0.95 : accuracy === 'high' ? 0.90 : 0.75,
    creativity_score: creativity,
    exploration_score: exploration,
    structure_score: structure,
    consistency_score: consistency,
    diversity_score: diversity,
    determinism_score: 1 - (exploration + diversity) / 2,
    risk_level: risk || 'none',
    verification_level: verification ? 'high' : 'medium',
    retry_strategy,
  };
}

function clampForModel(temp: number, modelKey: string): number {
  // 未注入解析器（纯代码路径 / 单元测试）→ 不做模型夹取，
  // 与原先「查不到该模型条目时原样返回」的旧行为等价。
  if (!modelResolver) return temp;
  const model = modelResolver(modelKey);
  if (!model) return temp;

  // Models with very high quality profiles handle higher temp better
  const quality = model.qualityProfile ?? 5;
  const speed = model.speedProfile ?? 5;

  // High-quality models can handle up to 1.5; low-quality capped at 1.0
  const modelMax = quality >= 8 ? 1.5 : quality >= 6 ? 1.2 : 1.0;

  // Fast models (high speed) handle lower temp better (more deterministic)
  const modelMin = speed >= 8 ? 0.05 : 0.10;

  return Math.max(modelMin, Math.min(modelMax, temp));
}

// ==================== Adaptive Retry ====================

export interface RetryDecision {
  should_retry: boolean;
  new_temperature?: number;
  reason?: string;
}

export function decideRetry(
  generation: GenerationProfile,
  outputValidation: { passed: boolean; issues: string[] },
  attempt: number,
): RetryDecision {
  if (outputValidation.passed) return { should_retry: false };
  if (generation.retry_strategy === 'none' || attempt >= 3) {
    return { should_retry: false, reason: 'retry limit reached or no retry strategy' };
  }
  if (generation.retry_strategy === 'single' && attempt >= 1) {
    return { should_retry: false, reason: 'single retry already used' };
  }

  // Adaptive: lower temperature on retry for factual/structured tasks
  const lowerTemp = Math.max(0.1, generation.temperature - 0.15);
  return {
    should_retry: true,
    new_temperature: lowerTemp,
    reason: `retry ${attempt + 1}, lowering temp to ${lowerTemp}`,
  };
}
