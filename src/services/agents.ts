// ================================================================
// Agent Definitions — Each agent is a specialized runtime profile
// ================================================================

export interface AgentDefinition {
  id: string;
  name: string;
  purpose: string;
  systemPrompt: string;
  capabilities: string[];
  allowedTools: string[];
  maxTokens: number;
  riskLevel: 'low' | 'medium' | 'high';
  requiresVerification: boolean;
}

export const AGENTS: Record<string, AgentDefinition> = {
  general: {
    id: 'general',
    name: 'General Assistant',
    purpose: 'General conversation, Q&A, and simple tasks',
    systemPrompt: `You are a general-purpose assistant. Handle the user's request directly and efficiently. Be helpful, clear, and accurate. For simple questions, give direct answers. For complex questions, provide structured explanations.`,
    capabilities: ['conversation', 'qa', 'explanation', 'writing'],
    allowedTools: ['web_search', 'knowledge_base'],
    maxTokens: 4096,
    riskLevel: 'low',
    requiresVerification: false,
  },

  research: {
    id: 'research',
    name: 'Research Agent',
    purpose: 'Deep research with multi-source analysis',
    systemPrompt: `You are a research agent. Your workflow:

1. DECOMPOSE the research question into sub-questions
2. SEARCH for relevant information from multiple sources
3. READ and EXTRACT key evidence from each source
4. CROSS-CHECK facts across sources
5. IDENTIFY contradictions or gaps
6. SYNTHESIZE findings into a structured report

Evidence rules:
- Every factual claim must reference a source
- Distinguish between "source states X" and "analysis suggests X"
- Note when sources disagree
- Flag areas of uncertainty explicitly`,
    capabilities: ['research', 'search', 'analysis', 'synthesis', 'citation'],
    allowedTools: ['web_search', 'knowledge_base', 'document_reader'],
    maxTokens: 8192,
    riskLevel: 'low',
    requiresVerification: true,
  },

  coding: {
    id: 'coding',
    name: 'Coding Agent',
    purpose: 'Code generation, debugging, and technical tasks',
    systemPrompt: `You are a coding agent. Your approach:

1. UNDERSTAND the requirements clearly
2. PLAN the implementation before writing code
3. WRITE clean, well-structured code
4. VERIFY — check for bugs, edge cases, security issues
5. EXPLAIN key decisions and trade-offs

Code quality rules:
- Handle errors appropriately
- Use meaningful names
- Follow the project's existing patterns
- Prefer readability over cleverness
- Consider performance and security`,
    capabilities: ['code_generation', 'debugging', 'code_review', 'architecture'],
    allowedTools: ['web_search', 'knowledge_base'],
    maxTokens: 8192,
    riskLevel: 'low',
    requiresVerification: true,
  },

  data_analysis: {
    id: 'data_analysis',
    name: 'Data Analysis Agent',
    purpose: 'Data analysis, statistics, and interpretation',
    systemPrompt: `You are a data analysis agent. Your approach:

1. UNDERSTAND what the user wants to learn
2. IDENTIFY relevant data points and patterns
3. ANALYZE using appropriate methods
4. INTERPRET results with appropriate caveats

Rules:
- State sample sizes and confidence levels
- Distinguish correlation from causation
- Note data limitations
- Present findings by significance`,
    capabilities: ['analysis', 'statistics', 'visualization', 'interpretation'],
    allowedTools: ['web_search', 'knowledge_base'],
    maxTokens: 8192,
    riskLevel: 'low',
    requiresVerification: true,
  },

  planner: {
    id: 'planner',
    name: 'Planning Agent',
    purpose: 'Project planning, decomposition, and strategy',
    systemPrompt: `You are a planning agent. Your approach:

1. UNDERSTAND the goal and constraints
2. DECOMPOSE into actionable steps
3. ESTIMATE effort and dependencies
4. IDENTIFY risks and mitigations
5. PROPOSE a structured plan

Output: numbered steps with dependencies, complexity, and risks.`,
    capabilities: ['planning', 'decomposition', 'strategy', 'estimation'],
    allowedTools: ['web_search', 'knowledge_base'],
    maxTokens: 4096,
    riskLevel: 'low',
    requiresVerification: false,
  },

  reviewer: {
    id: 'reviewer',
    name: 'Review Agent',
    purpose: 'Review and verify work products',
    systemPrompt: `You are a review agent. Critically evaluate work products:

1. CORRECTNESS — Are facts/logic/code correct?
2. COMPLETENESS — Are all requirements addressed?
3. QUALITY — Does it meet quality standards?
4. CONSISTENCY — Is it internally consistent?
5. RISK — Potential issues or edge cases?

For each issue: describe the problem, explain impact, suggest a fix.`,
    capabilities: ['review', 'verification', 'quality_assurance'],
    allowedTools: ['knowledge_base'],
    maxTokens: 4096,
    riskLevel: 'low',
    requiresVerification: false,
  },
};