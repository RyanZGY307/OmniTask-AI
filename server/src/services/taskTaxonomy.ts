// ================================================================
// Task Taxonomy — 100+ task types + response mode + all dimensions
// ================================================================

export const TASK_TYPES = [
  'answer', 'explanation', 'definition', 'why', 'how', 'troubleshooting', 'diagnosis',
  'verification', 'fact_check', 'research', 'deep_research', 'current_information',
  'source_lookup', 'evidence_analysis', 'recommendation', 'personalized_recommendation',
  'shortlist', 'multi_option', 'alternative_generation', 'single_choice',
  'decision_support', 'tradeoff_analysis', 'pros_cons', 'comparison',
  'feature_comparison', 'performance_comparison', 'cost_comparison', 'quality_comparison',
  'suitability_analysis', 'requirement_matching', 'ranking_request', 'prioritization',
  'selection', 'optimization', 'improvement', 'planning', 'project_planning',
  'task_planning', 'scheduling', 'strategy', 'brainstorming', 'ideation', 'naming',
  'concept_generation', 'design_generation', 'creative_writing', 'rewriting', 'polishing',
  'expansion', 'compression', 'summarization', 'extraction', 'classification',
  'transformation', 'formatting', 'translation', 'localization', 'tutoring', 'learning',
  'practice', 'correction', 'evaluation', 'calculation', 'mathematical_reasoning',
  'data_analysis', 'data_validation', 'data_transformation', 'code_generation',
  'code_explanation', 'code_debugging', 'code_review', 'code_refactoring',
  'code_optimization', 'architecture_analysis', 'file_analysis', 'document_analysis',
  'document_comparison', 'image_analysis', 'chart_analysis', 'diagram_analysis',
  'audio_analysis', 'video_analysis', 'simulation', 'scenario_analysis',
  'risk_analysis', 'feasibility_analysis', 'root_cause_analysis', 'impact_analysis',
  'requirement_analysis', 'specification_generation', 'checklist_generation',
  'template_generation', 'workflow_generation', 'instruction_generation', 'conversion',
  'quality_control', 'consistency_check', 'compliance_check', 'source_fidelity', 'synthesis',
  'product_analysis', 'market_research', 'financial_analysis', 'legal_analysis',
  'medical_analysis', 'technical_writing', 'email_writing', 'social_media',
  'report_writing', 'abstract_writing', 'presentation', 'outline_generation',
  'proofreading', 'grammar_correction', 'style_transfer', 'tone_adjustment',
  'api_design', 'database_design', 'system_design', 'security_audit', 'performance_tuning',
  'test_generation', 'ci_cd', 'deployment', 'monitoring', 'incident_response',
  'code_maintenance', 'documentation_generation', 'changelog_generation', 'release_notes',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const RESPONSE_MODES = [
  'single_answer', 'single_recommendation', 'multi_option', 'shortlist',
  'compare', 'decision_support', 'exploration', 'brainstorm',
  'information_only', 'step_by_step', 'deep_analysis',
] as const;
export type ResponseMode = (typeof RESPONSE_MODES)[number];

export const RECOMMENDATION_MODES = [
  'recommend_one', 'recommend_several', 'recommend_best_fit', 'recommend_budget',
  'recommend_requirement', 'recommend_current', 'recommend_alternative',
  'recommend_shortlist', 'recommend_with_reason', 'recommend_with_comparison',
] as const;
export type RecommendationMode = (typeof RECOMMENDATION_MODES)[number];

export const MULTI_OPTION_MODES = [
  'multi_option', 'multi_option_ranked', 'multi_option_unranked', 'multi_option_tradeoff',
  'multi_option_budget', 'multi_option_complexity', 'multi_option_risk',
  'multi_option_speed', 'multi_option_quality', 'multi_option_custom',
  'multi_option_fallback', 'multi_option_a_b', 'multi_option_comprehensive',
] as const;
export type MultiOptionMode = (typeof MULTI_OPTION_MODES)[number];

export const ANSWER_CARDINALITY = ['single', 'few', 'several', 'many', 'exhaustive', 'unknown'] as const;
export type AnswerCardinality = (typeof ANSWER_CARDINALITY)[number];

export const KNOWLEDGE_MODES = [
  'none', 'static', 'current', 'database', 'web', 'database_then_web',
  'multi_source', 'primary_source', 'verification', 'estimate', 'conflict',
] as const;
export type KnowledgeMode = (typeof KNOWLEDGE_MODES)[number];

export const ACCURACY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type AccuracyLevel = (typeof ACCURACY_LEVELS)[number];

export const AMBIGUITY_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type AmbiguityLevel = (typeof AMBIGUITY_LEVELS)[number];

export const FRESHNESS_LEVELS = ['none', 'stable', 'recent', 'current', 'real_time'] as const;
export type FreshnessLevel = (typeof FRESHNESS_LEVELS)[number];

export const OUTPUT_TYPES = [
  'text', 'structured', 'list', 'table', 'comparison_table', 'steps',
  'checklist', 'json', 'code', 'formula', 'timeline', 'matrix', 'report',
] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];

export const DEPTH_LEVELS = ['minimal', 'short', 'normal', 'detailed', 'deep', 'exhaustive'] as const;
export type DepthLevel = (typeof DEPTH_LEVELS)[number];

export const REASONING_STYLES = [
  'direct', 'analytical', 'comparative', 'stepwise', 'evidence_based',
  'constraint_based', 'diagnostic', 'exploratory', 'creative', 'structured',
] as const;
export type ReasoningStyle = (typeof REASONING_STYLES)[number];

export const RISK_LEVELS = ['none', 'low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

// ==================== Full Classification Result ====================

export interface MultiDimClassification {
  tasks: TaskType[];
  response_mode: ResponseMode;
  recommendation_mode?: RecommendationMode;
  multi_option_mode?: MultiOptionMode;
  answer_cardinality: AnswerCardinality;
  knowledge_mode: KnowledgeMode;
  accuracy: AccuracyLevel;
  creativity: number; // 0-5
  ambiguity: AmbiguityLevel;
  freshness: FreshnessLevel;
  output_type: OutputType;
  depth: DepthLevel;
  reasoning_style: ReasoningStyle;
  risk: RiskLevel;
  scenarios: string[];
  domains: string[];
  atoms: string[];
  knowledge_required: boolean;
  verification_required: boolean;
  option_count_hint?: number;
  metadata?: Record<string, any>;
}

// ==================== Local fallback classifier ====================

export function localClassify(message: string): MultiDimClassification {
  const msg = message.toLowerCase();

  const tasks: TaskType[] = [];
  let response_mode: ResponseMode = 'information_only';
  let recommendation_mode: RecommendationMode | undefined;
  let multi_option_mode: MultiOptionMode | undefined;
  let knowledge_mode: KnowledgeMode = 'static';
  let accuracy: AccuracyLevel = 'medium';
  let creativity = 1;
  let ambiguity: AmbiguityLevel = 'none';
  let freshness: FreshnessLevel = 'none';
  let output_type: OutputType = 'text';
  let depth: DepthLevel = 'normal';
  let reasoning_style: ReasoningStyle = 'direct';
  let risk: RiskLevel = 'none';
  const atoms: string[] = ['core.identity'];

  // Detection patterns
  if (/推荐|recommend|哪个好|选择|pick/i.test(msg)) {
    tasks.push('recommendation');
    response_mode = 'single_recommendation';
    if (/几款|多个|几个|top\s?\d|several|list/i.test(msg)) {
      response_mode = 'multi_option';
      multi_option_mode = 'multi_option_ranked';
    }
    recommendation_mode = /预算|budget|便宜/i.test(msg) ? 'recommend_budget' : 'recommend_best_fit';
    atoms.push('task.recommendation', 'recommendation.criteria');
  }
  if (/比较|对比|compare|区别|差异|tradeoff|pros.*cons/i.test(msg)) {
    tasks.push('comparison');
    response_mode = 'compare';
    output_type = 'comparison_table';
    atoms.push('task.comparison', 'output.comparison_table');
  }
  if (/分析|analyze|分析/i.test(msg)) {
    tasks.push('data_analysis');
    response_mode = 'deep_analysis';
    reasoning_style = 'analytical';
    depth = 'detailed';
    atoms.push('task.analysis');
  }
  if (/研究|research|调查|investigate/i.test(msg)) {
    tasks.push('research');
    knowledge_mode = 'database_then_web';
    freshness = 'recent';
    accuracy = 'high';
    atoms.push('task.research', 'knowledge.database_first');
  }
  if (/代码|code|函数|function|bug|error|debug|debug/i.test(msg)) {
    tasks.push('code_generation');
    output_type = 'code';
    reasoning_style = 'stepwise';
    atoms.push('task.code_generation');
    if (/debug|报错|error|异常|bug/i.test(msg)) {
      tasks.push('code_debugging');
      atoms.push('task.code_debugging', 'verification.fact');
    }
    if (/review|审查|代码审查/i.test(msg)) {
      tasks.push('code_review');
      atoms.push('task.code_review');
    }
  }
  if (/写|write|文章|essay|报告|report|邮件|email|文案/i.test(msg)) {
    tasks.push('creative_writing');
    response_mode = 'information_only';
    creativity = 3;
    atoms.push('task.writing');
  }
  if (/翻译|translate|localize|本地化/i.test(msg)) {
    tasks.push('translation');
    creativity = 0;
    atoms.push('task.translation');
  }
  if (/总结|summary|概括|简述|shorten|compress/i.test(msg)) {
    tasks.push('summarization');
    depth = 'short';
    atoms.push('task.summary', 'output.concise');
  }
  if (/规划|plan|schedule|排期|时间线|timeline/i.test(msg)) {
    tasks.push('planning');
    output_type = 'steps';
    atoms.push('task.planning', 'output.structured');
  }
  if (/头脑风暴|brainstorm|创意|idea|创意/i.test(msg)) {
    tasks.push('brainstorming');
    response_mode = 'brainstorm';
    creativity = 4;
    atoms.push('task.brainstorm', 'output.list');
  }
  if (/数学|math|计算|calculate|公式|formula/i.test(msg)) {
    tasks.push('calculation');
    accuracy = 'high';
    reasoning_style = 'stepwise';
    atoms.push('task.math', 'verification.fact');
  }
  if (/设计|design|架构|architecture|system design/i.test(msg)) {
    tasks.push('architecture_analysis');
    depth = 'deep';
    reasoning_style = 'analytical';
    atoms.push('task.design', 'task.analysis');
  }
  if (/总结|explain|解释|说明|什么是|what is/i.test(msg)) {
    if (tasks.length === 0) {
      tasks.push('explanation');
      atoms.push('task.explanation');
    }
  }

  // Default
  if (tasks.length === 0) {
    tasks.push('answer');
    atoms.push('core.answer_quality');
  }

  // Safety: risk detection
  if (/危险|hazard|safety|安全|爆炸|explosion|毒|poison/i.test(msg)) {
    risk = 'high';
  }

  // Ambiguity
  if (msg.includes('大概') || msg.includes('可能') || msg.includes('大约') || msg.includes('大概')) {
    ambiguity = 'low';
    accuracy = 'low';
  }
  if (/不确定|unclear|模糊|ambiguous/i.test(msg)) {
    ambiguity = 'medium';
  }

  // Freshness
  if (/最新|latest|最新|recent|最近|recent/i.test(msg)) {
    freshness = 'current';
    knowledge_mode = 'database_then_web';
  }
  if (/实时|real.time|live/i.test(msg)) {
    freshness = 'real_time';
    knowledge_mode = 'web';
  }

  // Scenarios
  const scenarios: string[] = [];
  if (tasks.includes('recommendation')) scenarios.push('recommendation.standard');
  if (tasks.includes('comparison')) scenarios.push('comparison.standard');
  if (tasks.includes('research')) scenarios.push('research.standard');
  if (tasks.includes('code_generation')) scenarios.push('code.generate');
  if (tasks.includes('creative_writing')) scenarios.push('writing.article');
  if (tasks.includes('translation')) scenarios.push('translation.standard');
  if (tasks.includes('summarization')) scenarios.push('summary.short');
  if (tasks.includes('planning')) scenarios.push('planning.standard');
  if (tasks.includes('brainstorming')) scenarios.push('brainstorm.standard');
  if (tasks.includes('calculation')) scenarios.push('math.calculation');
  if (tasks.includes('architecture_analysis')) scenarios.push('code.architecture');
  if (tasks.includes('explanation')) scenarios.push('explanation.technical_concept');
  if (scenarios.length === 0) scenarios.push('general.chat');

  return {
    tasks,
    response_mode,
    recommendation_mode,
    multi_option_mode,
    answer_cardinality: response_mode === 'multi_option' ? 'several' : 'single',
    knowledge_mode,
    accuracy,
    creativity,
    ambiguity,
    freshness,
    output_type,
    depth,
    reasoning_style,
    risk,
    scenarios,
    domains: [],
    atoms,
    knowledge_required: (knowledge_mode as string) !== 'none',
    verification_required: (accuracy as string) === 'high' || (accuracy as string) === 'critical',
  };
}
