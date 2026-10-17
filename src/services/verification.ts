// ================================================================
// Verification Runtime — Post-response quality checks
// ================================================================

import { TaskClassification } from './taskClassifier';

export interface VerificationResult {
  passed: boolean;
  score: number;
  checks: { name: string; passed: boolean; detail: string }[];
}

export function verifyResponse(
  task: TaskClassification,
  response: string,
): VerificationResult {
  const checks: { name: string; passed: boolean; detail: string }[] = [];

  const isComplete = response.length > 50;
  checks.push({ name: 'completeness', passed: isComplete, detail: isComplete ? 'Sufficient length' : 'Response too short' });

  if (task.taskType === 'coding') {
    const hasCode = response.includes('```') || response.includes('function ') || response.includes('const ');
    checks.push({ name: 'code_present', passed: hasCode, detail: hasCode ? 'Code detected' : 'No code in response' });
  }

  if (task.needsVerification || task.taskType === 'research') {
    const hasSources = /https?:\/\/|Source|来源|根据/.test(response);
    checks.push({ name: 'sources', passed: hasSources, detail: hasSources ? 'Sources referenced' : 'No sources cited' });
  }

  if (task.taskType === 'math') {
    const hasNumbers = /\d+/.test(response);
    checks.push({ name: 'mathematical', passed: hasNumbers, detail: hasNumbers ? 'Contains numbers' : 'No numerical content' });
  }

  const hedges = ['可能', '也许', '大概', 'perhaps', 'maybe', 'might'].filter(w => response.toLowerCase().includes(w));
  checks.push({
    name: 'confidence',
    passed: hedges.length <= 3,
    detail: hedges.length > 3 ? 'High uncertainty language' : 'Confidence acceptable',
  });

  const passedCount = checks.filter(c => c.passed).length;
  const score = checks.length ? passedCount / checks.length : 1;
  return { passed: score >= 0.5, score, checks };
}

export type ToolState = 'DISCOVERED' | 'AUTHORIZED' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED';

export interface ToolDefinition {
  name: string;
  description: string;
  capabilities: string[];
  risk: 'low' | 'medium' | 'high';
  readOnly: boolean;
  requiresConfirmation: boolean;
  costPerCall: number;
  timeoutMs: number;
  maxRetries: number;
}

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  web_search: {
    name: 'web_search', description: 'Search the web',
    capabilities: ['search', 'research'], risk: 'low', readOnly: true,
    requiresConfirmation: false, costPerCall: 1, timeoutMs: 10000, maxRetries: 2,
  },
  knowledge_base: {
    name: 'knowledge_base', description: 'Query knowledge base',
    capabilities: ['knowledge', 'reference'], risk: 'low', readOnly: true,
    requiresConfirmation: false, costPerCall: 0, timeoutMs: 5000, maxRetries: 1,
  },
  code_executor: {
    name: 'code_executor', description: 'Execute code in sandbox',
    capabilities: ['code_execution'], risk: 'medium', readOnly: false,
    requiresConfirmation: true, costPerCall: 5, timeoutMs: 30000, maxRetries: 1,
  },
};

const TRANSITIONS: Record<string, Record<string, ToolState>> = {
  DISCOVERED: { authorize: 'AUTHORIZED' },
  AUTHORIZED: { execute: 'EXECUTING', cancel: 'CANCELLED' },
  EXECUTING:  { success: 'SUCCEEDED', fail: 'FAILED', timeout: 'TIMEOUT', cancel: 'CANCELLED' },
  FAILED:     { retry: 'EXECUTING', cancel: 'CANCELLED' },
  TIMEOUT:    { retry: 'EXECUTING', cancel: 'CANCELLED' },
};

export function transitionToolState(current: ToolState, event: string): ToolState {
  return TRANSITIONS[current]?.[event] || current;
}

export function shouldRetry(
  error: string | undefined,
  attempt: number,
  tool: ToolDefinition,
): { retry: boolean; reason: string; waitMs: number } {
  if (attempt >= tool.maxRetries) return { retry: false, reason: 'Max retries exceeded', waitMs: 0 };
  if (!error) return { retry: false, reason: 'No error', waitMs: 0 };

  if (error.includes('timeout')) return { retry: true, reason: 'Timeout — retrying', waitMs: 1000 };
  if (error.includes('429') || error.includes('rate_limit')) return { retry: true, reason: 'Rate limited — backing off', waitMs: 5000 };
  if (error.includes('500') || error.includes('502') || error.includes('503')) return { retry: true, reason: 'Server error — retrying', waitMs: 2000 };

  if (!tool.readOnly) return { retry: false, reason: 'Write op failed — not auto-retrying', waitMs: 0 };

  return { retry: false, reason: 'Unknown error', waitMs: 0 };
}
