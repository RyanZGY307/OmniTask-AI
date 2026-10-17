// ================================================================
// Task Classifier — Rule-based, zero model cost
// ================================================================

export type TaskType =
  | 'simple_chat'
  | 'question'
  | 'coding'
  | 'research'
  | 'analysis'
  | 'writing'
  | 'math'
  | 'translation'
  | 'planning'
  | 'complex';

export interface TaskClassification {
  taskType: TaskType;
  complexity: 'simple' | 'moderate' | 'complex';
  suggestedAgent: string;
  requiredCapabilities: string[];
  suggestedSkills: string[];
  needsTools: boolean;
  needsWeb: boolean;
  needsMemory: boolean;
  needsVerification: boolean;
  estimatedTokens: number;
  confidence: number;
}

export function classifyTask(message: string, mode?: string): TaskClassification {
  const lower = message.toLowerCase();
  const wordCount = message.split(/\s+/).length;

  // Mode overrides
  if (mode === 'research') {
    return {
      taskType: 'research', complexity: 'complex', suggestedAgent: 'research',
      requiredCapabilities: ['research', 'search', 'analysis', 'citation'],
      suggestedSkills: ['web_research', 'knowledge_base'],
      needsTools: true, needsWeb: true, needsMemory: true, needsVerification: true,
      estimatedTokens: 8000, confidence: 0.95,
    };
  }
  if (mode === 'think') {
    return {
      taskType: 'complex', complexity: 'complex', suggestedAgent: 'general',
      requiredCapabilities: ['reasoning', 'analysis'],
      suggestedSkills: ['knowledge_base'],
      needsTools: false, needsWeb: false, needsMemory: true, needsVerification: true,
      estimatedTokens: 6000, confidence: 0.9,
    };
  }

  // Pattern matching
  if (match(lower, /\b(code|function|implement|debug|error|bug|api|endpoint|database|sql)\b/,
    /\b(python|javascript|typescript|react|node|css|html|java|c\+\+|rust|go|swift)\b/,
    /\b(class|method|variable|loop|array|object|async|await|import|export)\b/,
    /```/, /\b(代码|编程|函数|调试|报错|接口)\b/)) {
    return {
      taskType: 'coding', complexity: wordCount > 50 ? 'complex' : 'moderate',
      suggestedAgent: 'coding',
      requiredCapabilities: ['code_generation', 'debugging'],
      suggestedSkills: ['code_assistant'],
      needsTools: false, needsWeb: false, needsMemory: false, needsVerification: true,
      estimatedTokens: 4000, confidence: 0.85,
    };
  }

  if (match(lower, /\b(research|investigate|analyze.*(?:trend|market|industry)|deep\s*dive)\b/,
    /\b(compare.*(?:pros|cons|advantage|disadvantage))\b/,
    /\b(history|evolution|development).*of\b/,
    /\b(研究|调研|深入分析|对比)\b/)) {
    return {
      taskType: 'research', complexity: 'complex', suggestedAgent: 'research',
      requiredCapabilities: ['research', 'search', 'analysis'],
      suggestedSkills: ['web_research', 'knowledge_base'],
      needsTools: true, needsWeb: true, needsMemory: true, needsVerification: true,
      estimatedTokens: 6000, confidence: 0.8,
    };
  }

  if (match(lower, /\b(calculate|solve|equation|integral|derivative|matrix|proof|theorem)\b/,
    /\b(math|数学|计算|方程|求解|证明)\b/,
    /\d+\s*[\+\-\*\/\^\=]\s*\d+/)) {
    return {
      taskType: 'math', complexity: 'moderate', suggestedAgent: 'general',
      requiredCapabilities: ['math', 'calculation'],
      suggestedSkills: ['math_solver'],
      needsTools: false, needsWeb: false, needsMemory: false, needsVerification: true,
      estimatedTokens: 2000, confidence: 0.85,
    };
  }

  if (match(lower, /\b(translate|translation|翻译|翻譯|번역|翻訳)\b/,
    /\b(in|to|into)\s+(english|chinese|spanish|french|german|japanese|korean)\b/)) {
    return {
      taskType: 'translation', complexity: 'simple', suggestedAgent: 'general',
      requiredCapabilities: ['translation'],
      suggestedSkills: ['translation'],
      needsTools: false, needsWeb: false, needsMemory: false, needsVerification: false,
      estimatedTokens: 2000, confidence: 0.9,
    };
  }

  if (match(lower, /\b(write|draft|compose|essay|article|blog|email|letter|story|poem)\b/,
    /\b(edit|proofread|rewrite|improve.*writing)\b/,
    /\b(写|起草|文章|邮件|作文|故事)\b/)) {
    return {
      taskType: 'writing', complexity: wordCount > 30 ? 'moderate' : 'simple',
      suggestedAgent: 'general',
      requiredCapabilities: ['writing', 'content_creation'],
      suggestedSkills: ['writing_assistant'],
      needsTools: false, needsWeb: false, needsMemory: false, needsVerification: false,
      estimatedTokens: 3000, confidence: 0.8,
    };
  }

  if (match(lower, /\b(analyze|analysis|data|statistics|trend|pattern|chart|graph)\b/,
    /\b(correlation|regression|distribution|average|median)\b/,
    /\b(分析|数据|统计|趋势)\b/)) {
    return {
      taskType: 'analysis', complexity: 'moderate', suggestedAgent: 'data_analysis',
      requiredCapabilities: ['analysis', 'statistics'],
      suggestedSkills: ['data_analysis'],
      needsTools: false, needsWeb: false, needsMemory: false, needsVerification: true,
      estimatedTokens: 3000, confidence: 0.75,
    };
  }

  if (match(lower, /\b(plan|strategy|roadmap|timeline|milestone|project\s*plan)\b/,
    /\b(decompose|break\s*down|step\s*by\s*step|how\s*to\s*approach)\b/,
    /\b(计划|规划|方案|路线图)\b/)) {
    return {
      taskType: 'planning', complexity: 'moderate', suggestedAgent: 'planner',
      requiredCapabilities: ['planning', 'decomposition'],
      suggestedSkills: [],
      needsTools: false, needsWeb: false, needsMemory: true, needsVerification: false,
      estimatedTokens: 3000, confidence: 0.75,
    };
  }

  // Simple chat
  if (wordCount < 15 && !message.includes('?') && !message.includes('？')) {
    return {
      taskType: 'simple_chat', complexity: 'simple', suggestedAgent: 'general',
      requiredCapabilities: ['conversation'],
      suggestedSkills: [],
      needsTools: false, needsWeb: false, needsMemory: false, needsVerification: false,
      estimatedTokens: 1000, confidence: 0.7,
    };
  }

  // Default: general question
  return {
    taskType: 'question', complexity: wordCount > 50 ? 'moderate' : 'simple',
    suggestedAgent: 'general',
    requiredCapabilities: ['qa', 'explanation'],
    suggestedSkills: ['knowledge_base'],
    needsTools: false, needsWeb: false, needsMemory: true, needsVerification: false,
    estimatedTokens: 2000, confidence: 0.6,
  };
}

function match(text: string, ...patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}