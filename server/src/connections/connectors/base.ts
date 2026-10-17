// ================================================================
// Universal Connect Runtime v2 — Connector Base Classes
// ================================================================
//
// Each connector type implements this interface. The factory selects
// the best connector based on providerId + capability + toolId + health.
//
// Selection Algorithm (P0-1):
//   1. Look up provider manifest for supported capabilities
//   2. Match toolId → capability mapping
//   3. Select connector based on capability type + health + region
//   4. Return null if no matching connector (NOT "first available")
// ================================================================

import type { RiskLevel, ConnectorType } from '../types';

export interface ConnectorResult {
  ok: boolean;
  verified?: boolean;
  data?: any;
  error?: string;
}

export interface ConnectorContext {
  userId: string;
  connectionId: string;
  credentialId: string;
  accountId?: string;
  sessionId?: string;
  traceId?: string;
  requestId?: string;
  taskRunId?: string;
}

export interface CapabilityBinding {
  capabilityId: string;
  toolIds: string[];
  connectorType: ConnectorType;
  authMethod: string;
  riskLevel: RiskLevel;
  readOnly: boolean;
  regions?: string[];
}

export interface ConnectorDef extends BaseConnector {
  // Which provider+capability combinations this connector handles
  supportedCapabilities: CapabilityBinding[];
  // Required auth method
  requiredAuthMethod: string;
  // Default risk level
  defaultRiskLevel: RiskLevel;
}

export abstract class BaseConnector {
  abstract readonly type: ConnectorType;
  abstract readonly name: string;
  abstract supportedCapabilities: CapabilityBinding[];
  abstract requiredAuthMethod: string;
  abstract defaultRiskLevel: RiskLevel;

  /** Authenticate and return a credential reference */
  abstract authenticate(ctx: ConnectorContext, input: Record<string, any>): Promise<{ credentialId: string; accountId?: string; accountName?: string; sessionToken?: string }>;

  /** Execute a tool call */
  abstract execute(ctx: ConnectorContext, toolId: string, args: Record<string, any>): Promise<ConnectorResult>;

  /** Refresh auth if applicable */
  abstract refresh?(ctx: ConnectorContext): Promise<void>;

  /** Deauthenticate / revoke */
  abstract revoke(ctx: ConnectorContext): Promise<void>;

  /** Health check */
  abstract healthCheck(ctx: ConnectorContext): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;

  /** Verify post-action result against expected postcondition */
  protected verify(result: ConnectorResult, expectation: Record<string, any>): boolean {
    if (!result.ok) return false;
    if (!expectation || Object.keys(expectation).length === 0) return true;
    const actual = result.data || {};
    for (const [key, val] of Object.entries(expectation)) {
      if (val !== undefined && actual[key] !== val) return false;
    }
    return true;
  }

  /** Redact sensitive fields from args for preview/logging */
  protected redactArgs(args: Record<string, any>): Record<string, any> {
    const SENSITIVE = ['password', 'secret', 'token', 'apiKey', 'api_key', 'authorization', 'cookie', 'sessionToken', 'session_token', 'mfaCode', 'mfa_code', 'passkey', 'credential'];
    const redacted: Record<string, any> = {};
    for (const [k, v] of Object.entries(args)) {
      if (SENSITIVE.some((s) => k.toLowerCase().includes(s.toLowerCase()))) {
        redacted[k] = '[REDACTED]';
      } else {
        redacted[k] = v;
      }
    }
    return redacted;
  }
}

// ─── Registry ────────────────────────────────────────────────────────

const CONNECTORS: ConnectorDef[] = [];
const CAPABILITY_INDEX = new Map<string, ConnectorDef[]>(); // capabilityId → connectors

export function registerConnector(connector: ConnectorDef): void {
  CONNECTORS.push(connector);
  for (const binding of connector.supportedCapabilities) {
    if (!CAPABILITY_INDEX.has(binding.capabilityId)) {
      CAPABILITY_INDEX.set(binding.capabilityId, []);
    }
    CAPABILITY_INDEX.get(binding.capabilityId)!.push(connector);
  }
}

export function getConnector(type: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.type === type);
}

export function listConnectors(): ConnectorDef[] {
  return [...CONNECTORS];
}

// ─── Connector Selection (P0-1: precise matching) ───────────────────
// Returns null when no connector supports the requested capability/tool.
// Does NOT fall through to a generic connector.

export interface ConnectorSelection {
  connector: ConnectorDef;
  connectorType: string;
  capabilityId: string;
  confidence: number; // 0-1
  reason: string;
}

// Tool-to-capability mapping — maintained per-provider
const TOOL_CAPABILITY_MAP: Record<string, Record<string, string>> = {}; // providerId → { toolId → capabilityId }

export function registerToolMapping(providerId: string, toolId: string, capabilityId: string): void {
  if (!TOOL_CAPABILITY_MAP[providerId]) TOOL_CAPABILITY_MAP[providerId] = {};
  TOOL_CAPABILITY_MAP[providerId][toolId] = capabilityId;
}

export function getToolCapability(providerId: string, toolId: string): string | undefined {
  return TOOL_CAPABILITY_MAP[providerId]?.[toolId];
}

export function selectConnector(
  providerId: string,
  toolId: string,
  args: Record<string, any> = {},
): ConnectorSelection | null {
  // 1. Look up the capability for this tool+provider
  const capabilityId = getToolCapability(providerId, toolId);
  if (!capabilityId) return null;

  // 2. Find connectors that support this capability
  const candidates = CAPABILITY_INDEX.get(capabilityId) || [];
  if (candidates.length === 0) return null;

  // 3. Filter by auth method compatibility
  const authMethod = args._authMethod || 'api';
  const compatible = candidates.filter((c) => {
    // API connector handles api/oauth, OAuth handles oauth, Browser handles browser
    if (c.type === 'api' && (authMethod === 'api' || authMethod === 'oauth')) return true;
    if (c.type === 'oauth' && authMethod === 'oauth') return true;
    if (c.type === 'browser' && authMethod === 'browser') return true;
    return false;
  });

  // 4. Return best match (highest confidence)
  if (compatible.length === 0) return null;
  const best = compatible[0]; // currently all equal; future: score by health
  return {
    connector: best,
    connectorType: best.type,
    capabilityId,
    confidence: 0.95,
    reason: `matched capability ${capabilityId} → ${best.type}`,
  };
}

// ─── Direct capability lookup ──────────────────────────────────────

export function getConnectorForCapability(capabilityId: string, authMethod: string): ConnectorDef | null {
  const candidates = CAPABILITY_INDEX.get(capabilityId) || [];
  for (const c of candidates) {
    if (authMethod === 'api' && (c.type === 'api' || c.type === 'oauth')) return c;
    if (authMethod === 'oauth' && c.type === 'oauth') return c;
    if (authMethod === 'browser' && c.type === 'browser') return c;
  }
  return null;
}
