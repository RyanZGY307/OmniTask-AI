// ================================================================
// Skill Definitions — Dynamically loaded capability modules
// ================================================================

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  triggers: string[];
  requiredTier: 'STANDARD' | 'PRO' | 'ULTRA';
}

export const SKILLS: Record<string, SkillDefinition> = {
  web_research: {
    id: 'web_research',
    name: 'Web Research',
    description: 'Search and analyze web content',
    systemPrompt: `Web Research active:
- Search the web for current information
- Cite source URLs when using web data
- Distinguish authoritative sources from opinions
- Note retrieval date for time-sensitive info
- Cross-reference multiple sources when possible`,
    capabilities: ['search', 'web_browse', 'content_extraction'],
    triggers: ['search', 'find', 'look up', 'latest', 'current', 'news', 'today', 'recent', 'what is', 'who is', '搜索', '查找', '最新', '新闻'],
    requiredTier: 'STANDARD',
  },

  knowledge_base: {
    id: 'knowledge_base',
    name: 'Knowledge Base',
    description: 'Access internal knowledge base',
    systemPrompt: `Knowledge Base access active:
- Reference curated knowledge entries by title
- If KB content conflicts with training data, prefer KB (more recent)
- Note evidence level of knowledge entries`,
    capabilities: ['knowledge_query', 'fact_check', 'reference'],
    triggers: ['according to', 'policy', '规则', '规定', '知识库', 'based on'],
    requiredTier: 'STANDARD',
  },

  code_assistant: {
    id: 'code_assistant',
    name: 'Code Assistant',
    description: 'Code generation, review, and debugging',
    systemPrompt: `Code Assistant active:
- Format code blocks with language identifiers
- Explain non-obvious decisions
- Consider security implications
- Handle errors and edge cases
- When debugging, trace to root cause before suggesting fixes`,
    capabilities: ['code_gen', 'code_review', 'debug', 'refactor'],
    triggers: ['code', 'function', 'implement', 'debug', 'error', 'bug', 'api', 'database', 'sql', 'python', 'javascript', 'typescript', 'react', '代码', '编程', '函数', '报错'],
    requiredTier: 'STANDARD',
  },

  data_analysis: {
    id: 'data_analysis',
    name: 'Data Analysis',
    description: 'Data analysis and interpretation',
    systemPrompt: `Data Analysis active:
- Identify patterns and outliers in data
- Use appropriate statistical methods
- Note sample sizes and potential biases
- Distinguish descriptive and inferential statistics`,
    capabilities: ['analysis', 'statistics', 'pattern_recognition'],
    triggers: ['analyze', 'data', 'statistics', 'chart', 'graph', 'trend', 'pattern', '分析', '数据', '统计', '趋势'],
    requiredTier: 'PRO',
  },

  writing_assistant: {
    id: 'writing_assistant',
    name: 'Writing Assistant',
    description: 'Professional writing and editing',
    systemPrompt: `Writing Assistant active:
- Match tone to user's intent
- Formal writing: clear structure, proper transitions
- Creative writing: vivid language, literary devices
- Editing: explain changes briefly
- Maintain the user's voice when editing their content`,
    capabilities: ['writing', 'editing', 'proofreading', 'content_creation'],
    triggers: ['write', 'draft', 'compose', 'essay', 'article', 'email', 'letter', 'blog', '写', '文章', '邮件', '编辑', '作文'],
    requiredTier: 'STANDARD',
  },

  math_solver: {
    id: 'math_solver',
    name: 'Math Solver',
    description: 'Mathematical problem solving',
    systemPrompt: `Math Solver active:
- Show step-by-step solutions
- Explain reasoning behind each step
- Verify answers against the original problem
- For complex problems, break into sub-problems`,
    capabilities: ['math', 'calculation', 'proof', 'equation'],
    triggers: ['calculate', 'solve', 'equation', 'math', 'integral', 'derivative', 'proof', '计算', '数学', '方程', '解题'],
    requiredTier: 'STANDARD',
  },

  translation: {
    id: 'translation',
    name: 'Translation',
    description: 'Multi-language translation',
    systemPrompt: `Translation active:
- Preserve meaning, tone, and intent — not just words
- Adapt idioms and cultural references appropriately
- Use domain-standard terminology for technical content
- Note when a direct translation doesn't exist`,
    capabilities: ['translation', 'localization', 'cultural_adaptation'],
    triggers: ['translate', '翻译', '翻譯', '번역', '翻訳'],
    requiredTier: 'STANDARD',
  },
};