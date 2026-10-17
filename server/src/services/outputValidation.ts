// ================================================================
// Output Validation + Adaptive Retry
// ================================================================

export interface OutputValidationResult {
  passed: boolean;
  issues: string[];
  repetition: number;
  offTopic: boolean;
  formatFailure: boolean;
  instructionFailure: boolean;
  qualityDegradation: boolean;
  factualInstability: boolean;
  lowDiversity: boolean;
}

export interface RetryDecision {
  shouldRetry: boolean;
  adjustedTemperature?: number;
  adjustedTopP?: number;
  reason: string;
  attempt: number;
}

const MAX_RETRIES = 3;

export function validateOutput(
  output: string,
  expectedFormat?: string,
  userMessage?: string,
): OutputValidationResult {
  const issues: string[] = [];
  const addIssue = (msg: string) => { if (!issues.includes(msg)) issues.push(msg); };

  // Repetition check
  const repetition = detectRepetition(output);
  if (repetition > 0.4) addIssue(`High repetition detected (${(repetition * 100).toFixed(0)}%)`);

  // Off-topic check
  const offTopic = userMessage ? detectOffTopic(output, userMessage) : false;
  if (offTopic) addIssue('Response appears off-topic relative to user question');

  // Format check
  const formatFailure = expectedFormat ? checkFormat(output, expectedFormat) : false;
  if (formatFailure) addIssue(`Format mismatch: expected ${expectedFormat}`);

  // Instruction failure — empty or very short response
  const instructionFailure = output.trim().length < 20;
  if (instructionFailure) addIssue('Response too short — possible instruction failure');

  // Low diversity check
  const lowDiversity = detectLowDiversity(output);
  if (lowDiversity) addIssue('Low lexical diversity — repetitive phrasing');

  // Factual instability — contradictory statements
  const factualInstability = detectContradictions(output);
  if (factualInstability) addIssue('Internal contradiction detected in response');

  // Quality degradation — too many hedging phrases
  const qualityDegradation = countHedging(output) > 5;
  if (qualityDegradation) addIssue('Excessive hedging — quality degradation');

  const passed = issues.length === 0;
  return {
    passed,
    issues,
    repetition,
    offTopic,
    formatFailure,
    instructionFailure,
    qualityDegradation,
    factualInstability,
    lowDiversity,
  };
}

export function decideRetry(
  validation: OutputValidationResult,
  attempt: number,
  baseTemperature: number,
  baseTopP?: number,
): RetryDecision {
  if (validation.passed) {
    return { shouldRetry: false, reason: 'Output passed validation', attempt };
  }

  if (attempt >= MAX_RETRIES) {
    return { shouldRetry: false, reason: `Max retries (${MAX_RETRIES}) reached`, attempt };
  }

  // Determine adjustment strategy based on issue type
  let adjustedTemp = baseTemperature;
  let adjustedTopP = baseTopP;
  let reason = `Retry ${attempt + 1}: ${validation.issues[0]}`;

  if (validation.repetition > 0.4 || validation.lowDiversity) {
    // Lower temperature to reduce repetition
    adjustedTemp = Math.max(0.1, baseTemperature - 0.2);
    if (adjustedTopP) adjustedTopP = Math.max(0.5, baseTopP - 0.1);
    reason = `Retry ${attempt + 1}: reducing temperature to ${adjustedTemp.toFixed(2)} for repetition/diversity`;
  } else if (validation.offTopic) {
    // Lower temperature for focus
    adjustedTemp = Math.max(0.1, baseTemperature - 0.15);
    reason = `Retry ${attempt + 1}: reducing temperature to ${adjustedTemp.toFixed(2)} for off-topic`;
  } else if (validation.formatFailure) {
    // Lower temperature for format compliance
    adjustedTemp = Math.max(0.1, baseTemperature - 0.2);
    reason = `Retry ${attempt + 1}: reducing temperature to ${adjustedTemp.toFixed(2)} for format compliance`;
  } else if (validation.instructionFailure) {
    // Keep temperature, just retry
    reason = `Retry ${attempt + 1}: instruction failure, retrying with same params`;
  } else if (validation.factualInstability) {
    // Lower temperature for consistency
    adjustedTemp = Math.max(0.1, baseTemperature - 0.25);
    reason = `Retry ${attempt + 1}: reducing temperature to ${adjustedTemp.toFixed(2)} for factual consistency`;
  } else {
    reason = `Retry ${attempt + 1}: ${validation.issues[0]}`;
  }

  return {
    shouldRetry: true,
    adjustedTemperature: adjustedTemp,
    adjustedTopP,
    reason,
    attempt: attempt + 1,
  };
}

// ==================== Detection Helpers ====================

function detectRepetition(text: string): number {
  if (text.length < 100) return 0;
  const words = text.toLowerCase().split(/\s+/);
  if (words.length < 10) return 0;
  const freq = new Map<string, number>();
  for (const w of words) {
    if (w.length > 3) freq.set(w, (freq.get(w) || 0) + 1);
  }
  const total = words.length;
  let repeatedCount = 0;
  for (const count of freq.values()) {
    if (count > total * 0.15) repeatedCount += count;
  }
  return Math.min(1, repeatedCount / total);
}

function detectOffTopic(output: string, userMessage: string): boolean {
  const outWords = new Set(output.toLowerCase().split(/\s+/).filter(w => w.length > 5));
  const userWords = new Set(userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 5));
  if (userWords.size === 0) return false;
  let overlap = 0;
  for (const w of userWords) {
    if (outWords.has(w)) overlap++;
  }
  // If less than 15% of user message keywords appear in output, likely off-topic
  return overlap / userWords.size < 0.15 && outWords.size > 20;
}

function checkFormat(output: string, expected: string): boolean {
  switch (expected) {
    case 'json':
      try { JSON.parse(output); return false; } catch { return true; }
    case 'code':
      return !output.includes('```') && output.length < 50;
    case 'table':
      return !output.includes('|') && !output.includes('---');
    case 'list':
      return !output.includes('- ') && !output.includes('1.') && !output.match(/^\s*•/m);
    case 'steps':
      return !output.match(/^\s*\d+[.)]/m);
    case 'comparison_table':
      return !output.includes('|') || !output.includes('---');
    default:
      return false;
  }
}

function detectLowDiversity(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length < 20) return false;
  const unique = new Set(words);
  const diversity = unique.size / words.length;
  return diversity < 0.4;
}

function detectContradictions(text: string): boolean {
  const contradictionPatterns = [
    /yes[^\n]{0,100}no[^\n]{0,100}yes|no[^\n]{0,100}yes[^\n]{0,100}no/i,
    /always[^\n]{0,200}never|never[^\n]{0,200}always/i,
    /impossible[^\n]{0,100}possible|possible[^\n]{0,100}impossible/i,
  ];
  return contradictionPatterns.some(p => p.test(text));
}

function countHedging(text: string): number {
  const patterns = /perhaps|possibly|maybe|it could be|it might|not certain|unclear|arguably/i;
  const matches = text.match(new RegExp(patterns.source, 'gi'));
  return matches ? matches.length : 0;
}
