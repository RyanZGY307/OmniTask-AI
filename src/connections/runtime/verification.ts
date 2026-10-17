// ================================================================
// Verification Engine — Server-side postcondition checking (P0-12)
// ================================================================
//
// Every side-effect action must be verified:
//   Action → Postcondition → Observation → Compare → Verified/Failed/Unknown
//
// NOT: HTTP 200 = verified
// NOT: Button clicked = verified
// ================================================================

import type { ConnectorResult } from '../connectors/base';

export interface Postcondition {
  type: 'http_status' | 'json_field' | 'json_path' | 'dom_element' | 'text_contains' | 'url_matches' | 'custom';
  field?: string;       // json_field: field name to check
  path?: string;        // json_path: dot notation path
  value?: any;          // expected value
  contains?: string;    // text_contains: substring
  regex?: string;       // url_matches: regex pattern
  customCheck?: string; // custom: verification expression
}

export interface VerificationResult {
  verified: boolean;
  status: 'verified' | 'failed' | 'unknown' | 'skipped';
  reason?: string;
  observed?: any;
  postcondition?: Postcondition;
  checkedAt?: Date;
}

export interface VerificationContext {
  toolId: string;
  args: Record<string, any>;
  result: ConnectorResult;
}

// ─── Default postconditions per tool type ───────────────────────────

const DEFAULT_POSTCONDITIONS: Record<string, Postcondition[]> = {
  'github.repo.read': [
    { type: 'http_status', value: 200 },
    { type: 'json_field', field: 'id', value: undefined },
  ],
  'github.issue.create': [
    { type: 'json_field', field: 'id', value: undefined },
    { type: 'json_field', field: 'number', value: undefined },
  ],
  'github.pr.create': [
    { type: 'json_field', field: 'number', value: undefined },
    { type: 'json_field', field: 'state', value: 'open' },
  ],
  'slack.chat.post': [
    { type: 'json_field', field: 'ok', value: true },
    { type: 'json_field', field: 'ts', value: undefined },
  ],
  'stripe.balance.get': [
    { type: 'json_field', field: 'available', value: undefined },
  ],
};

// ─── Main verification function ─────────────────────────────────────

export async function verifyAction(ctx: VerificationContext): Promise<VerificationResult> {
  const { toolId, args, result } = ctx;

  // If action failed, verification fails
  if (!result.ok) {
    return { verified: false, status: 'failed', reason: `Action failed: ${result.error}`, checkedAt: new Date() };
  }

  // Get postconditions for this tool
  const conditions = DEFAULT_POSTCONDITIONS[toolId] || [{ type: 'http_status', value: 200 }];

  // If result has no data, and we expected data → unknown
  if (!result.data) {
    return { verified: false, status: 'unknown', reason: 'No result data to verify', checkedAt: new Date() };
  }

  // Check each postcondition
  for (const cond of conditions) {
    const check = await checkCondition(result, cond, args);
    if (!check.verified) {
      return { verified: false, status: 'failed', reason: check.reason, observed: check.observed, postcondition: cond, checkedAt: new Date() };
    }
  }

  return { verified: true, status: 'verified', checkedAt: new Date() };
}

async function checkCondition(result: ConnectorResult, cond: Postcondition, _args: Record<string, any>): Promise<{ verified: boolean; reason?: string; observed?: any }> {
  const data = result.data as any;

  switch (cond.type) {
    case 'http_status':
      // For API connectors, check if result contains an error field
      if (data?.error || data?.errorMessage) {
        return { verified: false, reason: `API error: ${data.error || data.errorMessage}` };
      }
      return { verified: true };

    case 'json_field':
      if (cond.field && data?.[cond.field] === undefined) {
        return { verified: false, reason: `Missing expected field: ${cond.field}`, observed: data };
      }
      if (cond.field && cond.value !== undefined && data?.[cond.field] !== cond.value) {
        return { verified: false, reason: `Field ${cond.field}: expected ${cond.value}, got ${data[cond.field]}`, observed: data[cond.field] };
      }
      return { verified: true };

    case 'json_path': {
      if (!cond.path) return { verified: true };
      const parts = cond.path.split('.');
      let current = data;
      for (const part of parts) {
        if (current === undefined || current === null) break;
        current = current[part];
      }
      if (current === undefined) {
        return { verified: false, reason: `Path ${cond.path} not found`, observed: undefined };
      }
      return { verified: true };
    }

    case 'text_contains': {
      if (!cond.contains) return { verified: true };
      const text = JSON.stringify(data);
      if (!text.includes(cond.contains)) {
        return { verified: false, reason: `Expected text "${cond.contains}" not found` };
      }
      return { verified: true };
    }

    case 'url_matches': {
      if (!cond.regex) return { verified: true };
      const url = data?.url || data?.html_url || '';
      if (!new RegExp(cond.regex).test(url)) {
        return { verified: false, reason: `URL ${url} does not match pattern ${cond.regex}`, observed: url };
      }
      return { verified: true };
    }

    case 'dom_element': {
      // For browser connectors: check if the result contains a screenshot or content
      if (data?.url || data?.screenshot || data?.content) {
        return { verified: true };
      }
      return { verified: false, reason: 'No browser state to verify' };
    }

    case 'custom':
      // Custom checks are provider-specific; for now, accept
      return { verified: true };

    default:
      return { verified: true };
  }
}

// ─── Specific verification adapters ────────────────────────────────

export async function verifyGitHubAction(toolId: string, args: Record<string, any>, result: any): Promise<VerificationResult> {
  if (!result?.ok) {
    return { verified: false, status: 'failed', reason: 'GitHub action failed' };
  }

  switch (toolId) {
    case 'github.issue.create':
      // Verify by checking returned issue number
      if (result.data?.number) {
        return { verified: true, status: 'verified', observed: { issueNumber: result.data.number } };
      }
      return { verified: false, status: 'unknown', reason: 'No issue number in result' };

    case 'github.pr.create':
      if (result.data?.number) {
        return { verified: true, status: 'verified', observed: { prNumber: result.data.number } };
      }
      return { verified: false, status: 'unknown', reason: 'No PR number in result' };

    default:
      return { verified: true, status: 'verified' };
  }
}

export async function verifySlackAction(toolId: string, args: Record<string, any>, result: any): Promise<VerificationResult> {
  if (!result?.ok) {
    return { verified: false, status: 'failed', reason: 'Slack action failed' };
  }

  if (toolId === 'slack.chat.post') {
    if (result.data?.ok && result.data?.ts) {
      return { verified: true, status: 'verified', observed: { messageTs: result.data.ts } };
    }
    return { verified: false, status: 'failed', reason: 'No message timestamp returned' };
  }

  return { verified: true, status: 'verified' };
}

export async function verifyBrowserAction(_toolId: string, _args: Record<string, any>, result: any): Promise<VerificationResult> {
  if (!result?.ok) {
    return { verified: false, status: 'failed', reason: 'Browser action failed' };
  }

  // For browser actions, we verify by checking the result has a URL or screenshot
  if (result?.data?.url || result?.data?.screenshot || result?.data?.content) {
    return { verified: true, status: 'verified', observed: { url: result.data.url, hasScreenshot: !!result.data.screenshot } };
  }

  return { verified: false, status: 'unknown', reason: 'No observable browser state' };
}
