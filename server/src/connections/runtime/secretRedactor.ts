// ================================================================
// Secret Redactor — prevent sensitive data in previews/logs
// ================================================================
//
// P0-11: Action preview, trace events, and error messages must never
// contain passwords, API keys, tokens, cookies, or MFA codes.

const SENSITIVE_PATTERNS = [
  'password',
  'secret',
  'token',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'session_token',
  'sessiontoken',
  'mfa_code',
  'mfacode',
  'passkey',
  'credential',
  'private_key',
  'privatekey',
  'access_key',
  'accesskey',
];

const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'api-key',
];

export function redactValue(value: any): any {
  if (typeof value === 'string') {
    // Check if it looks like a secret (long hex, JWT, base64 token)
    if (/^[a-f0-9]{40,}$/.test(value)) return '[REDACTED_HEX]';
    if (value.startsWith('eyJ')) return '[REDACTED_JWT]';
    if (value.length > 32 && /^[A-Za-z0-9+/=-]+$/.test(value)) return '[REDACTED_BASE64]';
  }
  return value;
}

export function redactArgs(args: Record<string, any>): Record<string, any> {
  const redacted: Record<string, any> = {};
  for (const [key, value] of Object.entries(args)) {
    const keyLower = key.toLowerCase();
    if (SENSITIVE_PATTERNS.some((p) => keyLower.includes(p))) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactArgs(value as Record<string, any>);
    } else {
      redacted[key] = redactValue(value);
    }
  }
  return redacted;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.some((p) => key.toLowerCase() === p)) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export function redactPreview(preview: Record<string, any>): Record<string, any> {
  const redacted: Record<string, any> = {};
  for (const [key, value] of Object.entries(preview)) {
    const keyLower = key.toLowerCase();
    if (keyLower === 'args' && typeof value === 'object') {
      redacted[key] = redactArgs(value as Record<string, any>);
    } else if (keyLower === 'headers' && typeof value === 'object') {
      redacted[key] = redactHeaders(value as Record<string, string>);
    } else if (SENSITIVE_PATTERNS.some((p) => keyLower.includes(p))) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}
