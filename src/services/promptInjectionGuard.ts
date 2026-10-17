// ================================================================
// Prompt Injection Guard — detect and neutralize injection attempts
// ================================================================

export interface InjectionCheckResult {
  isInjection: boolean;
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  indicators: string[];
  sanitized?: string;
}

const INJECTION_PATTERNS: Array<{ pattern: RegExp; severity: string; label: string }> = [
  { pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|guidelines)/i, severity: 'high', label: 'instruction override attempt' },
  { pattern: /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/i, severity: 'high', label: 'instruction override attempt' },
  { pattern: /forget\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|context)/i, severity: 'high', label: 'instruction override attempt' },
  { pattern: /you\s+are\s+now\s+(a|an|the)\s+/i, severity: 'medium', label: 'role hijack attempt' },
  { pattern: /pretend\s+(to\s+be|you\s+are)\s+/i, severity: 'medium', label: 'role hijack attempt' },
  { pattern: /act\s+as\s+if\s+(you\s+)?(no\s+longer\s+)?(have|follow)\s+/i, severity: 'medium', label: 'rule bypass attempt' },
  { pattern: /new\s+rule[s]?\s*:/i, severity: 'low', label: 'rule injection attempt' },
  { pattern: /system\s*:\s*$/im, severity: 'high', label: 'system prompt injection' },
  { pattern: /\[SYSTEM\]|\[SYSTEM\s+PROMPT\]|\[INSTRUCTIONS\]/i, severity: 'high', label: 'system tag injection' },
  { pattern: /<<\s*SYSTEM\s*>>|<<\s*INSTRUCTIONS\s*>>/i, severity: 'high', label: 'delimiter injection' },
  { pattern: /override\s+(all\s+)?(safety|security|policy|guideline)/i, severity: 'critical', label: 'safety override attempt' },
  { pattern: /bypass\s+(all\s+)?(safety|security|policy|guideline|filter)/i, severity: 'critical', label: 'safety bypass attempt' },
  { pattern: /reveal\s+(your|the)\s+(system\s+)?(prompt|instructions|rules)/i, severity: 'high', label: 'prompt extraction attempt' },
  { pattern: /show\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions|rules)/i, severity: 'high', label: 'prompt extraction attempt' },
  { pattern: /what\s+(are|is)\s+your\s+(system\s+)?(prompt|instructions|rules)/i, severity: 'medium', label: 'prompt probing' },
  { pattern: /output\s+(your|the)\s+(system\s+)?(prompt|instructions)/i, severity: 'high', label: 'prompt extraction attempt' },
  { pattern: /print\s+(your|the)\s+(system\s+)?(prompt|instructions)/i, severity: 'high', label: 'prompt extraction attempt' },
  { pattern: /\bDAN\b|\bdeveloper\s+mode\b/i, severity: 'high', label: 'jailbreak keyword' },
  { pattern: /jail\s*break|越狱/i, severity: 'high', label: 'jailbreak keyword' },
  { pattern: /act\s+as\s+(an?\s+)?unrestricted|unfiltered|uncensored/i, severity: 'critical', label: 'unrestricted mode attempt' },
  { pattern: /pretend\s+(you\s+)?(have|are)\s+(no|no\s+)?(restrictions|limits|rules)/i, severity: 'critical', label: 'restriction bypass attempt' },
];

export function checkInjection(message: string): InjectionCheckResult {
  const indicators: string[] = [];
  let maxSeverity = 0;

  const severityMap: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

  for (const { pattern, severity, label } of INJECTION_PATTERNS) {
    if (pattern.test(message)) {
      indicators.push(label);
      maxSeverity = Math.max(maxSeverity, severityMap[severity]);
    }
  }

  const severityNames = ['none', 'low', 'medium', 'high', 'critical'];
  const isInjection = maxSeverity >= 2; // medium or above

  // Sanitize: strip dangerous patterns from the message
  let sanitized = message;
  if (isInjection) {
    for (const { pattern } of INJECTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[BLOCKED: potential injection]');
    }
  }

  return {
    isInjection,
    severity: severityNames[maxSeverity] as InjectionCheckResult['severity'],
    indicators,
    sanitized: isInjection ? sanitized : undefined,
  };
}

export function isSafeForKnowledge(message: string): boolean {
  const result = checkInjection(message);
  return !result.isInjection || result.severity === 'low';
}
