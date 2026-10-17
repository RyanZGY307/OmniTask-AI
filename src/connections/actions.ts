// ================================================================
// Action Approval Runtime
//
// All external (non-readonly) operations flow through here:
//   Prepare → Permission Check → Human-readable Preview →
//   [User Approval] → Execute → Verify → record result
//
// Readonly actions (R0) may execute immediately when the policy is
// "auto". Anything that needs approval creates a pending
// ActionRequest that a user (on any device) can approve/reject.
// ================================================================

import { prisma } from '../services/db';
import { GITHUB_TOOLS, executeGitHubTool } from './github';
import { checkPermission } from './permissionEngine';
import { addEvent, createTrace, newTraceId, newRequestId } from '../services/trace';
import { getProvider, getTool, LEGACY_TOOLS } from './providers';
import { selectConnector, listConnectors } from './connectors/base';
import { getProviderById } from './registry/global';
import { RiskLevel } from './types';
import { redactPreview } from './runtime/secretRedactor';

const ACTION_TTL_MS = 30 * 60 * 1000;

/** Every connection operation is auditable: create a trace when the caller didn't provide one. */
async function ensureTrace(userId: string, existing?: string): Promise<string> {
  if (existing) return existing;
  const traceId = newTraceId();
  await createTrace({ traceId, requestId: newRequestId(), userId });
  return traceId;
}

export interface CreateActionInput {
  userId: string;
  connectionId: string;
  toolId: string;
  args?: any;
  traceId?: string;
  requestedBy?: string;
}

export type CreateActionResult =
  | { executed: true; status: 'executed'; result: unknown; actionId: string }
  | { executed: false; actionId: string; status: 'pending'; preview: unknown }
  | { executed: false; actionId: string; status: 'denied'; reason: string };

function buildPreview(toolId: string, args: any): Record<string, any> {
  // Check legacy GitHub tools first
  const tool = GITHUB_TOOLS[toolId] || (LEGACY_TOOLS.find((t) => t.id === toolId) as any);
  const rawPreview: Record<string, any> = { toolId, args: args || {} };
  if (tool) {
    rawPreview.riskLevel = tool.riskLevel;
    rawPreview.description = tool.description || tool.action;
    rawPreview.readOnly = tool.readOnly;
  }
  // P0-11: Redact ALL sensitive fields before returning
  return redactPreview(rawPreview);
}

function riskForTool(toolId: string): RiskLevel {
  const tool = GITHUB_TOOLS[toolId] || (LEGACY_TOOLS.find((t) => t.id === toolId) as any);
  return (tool?.riskLevel || 'R2') as RiskLevel;
}

function requiredCapabilityForTool(toolId: string): string | undefined {
  const tool = GITHUB_TOOLS[toolId] || (LEGACY_TOOLS.find((t) => t.id === toolId) as any);
  return tool?.capabilities?.[0];
}

/** Execute action through the appropriate connector (GitHub or universal) */
async function executeAction(
  connectionId: string,
  userId: string,
  toolId: string,
  args: any,
): Promise<{ ok: boolean; verified: boolean; data?: any; error?: string }> {
  // P0-2: Unified execution — no dual-path
  const conn = await prisma.connection.findFirst({ where: { id: connectionId, userId }, select: { providerId: true, credentialRef: true, account: true, authMethod: true } });
  if (!conn) return { ok: false, verified: false, error: 'Connection not found' };

  // 1. Try native adapter first (GitHub, etc.)
  if (GITHUB_TOOLS[toolId]) {
    const result = await executeGitHubTool({ connectionId, userId, toolId, args });
    return { ok: result.ok, verified: result.verified ?? true, data: result.data, error: result.error };
  }

  // 2. Use universal connector with precise capability matching
  const selection = selectConnector(conn.providerId, toolId, { _authMethod: conn.authMethod });
  if (!selection) return { ok: false, verified: false, error: `No connector for ${conn.providerId}/${toolId}` };

  const ctx = {
    userId,
    connectionId,
    credentialId: conn.credentialRef || '',
    accountId: conn.account || undefined,
    traceId: undefined,
    requestId: undefined,
  };

  try {
    const result = await selection.connector.execute(ctx, toolId, args);
    return { ok: result.ok, verified: result.verified ?? false, data: result.data, error: result.error } as any;
  } catch (err: any) {
    return { ok: false, verified: false, error: err.message };
  }
}

export async function createAction(input: CreateActionInput): Promise<CreateActionResult> {
  const { userId, connectionId, toolId, args, traceId, requestedBy } = input;
  const trace = await ensureTrace(userId, traceId);
  const conn = await prisma.connection.findFirst({ where: { id: connectionId, userId } });
  if (!conn) throw new Error('Connection not found');
  if (!GITHUB_TOOLS[toolId] && !LEGACY_TOOLS.find((t) => t.id === toolId)) throw new Error(`Unknown tool: ${toolId}`);

  const check = await checkPermission({
    userId,
    riskLevel: riskForTool(toolId),
    requiredCapability: requiredCapabilityForTool(toolId) as any,
    connection: { ...conn, permissions: JSON.parse(conn.permissions || '[]'), scopes: JSON.parse(conn.scopes || '[]') } as any,
  });

  // 1. Execute immediately for auto / readonly
  if (check.decision === 'allow') {
    await addEvent(trace, 'PERMISSION', { toolId, riskLevel: riskForTool(toolId), decision: 'allow' }, 'success');
    const result: any = await executeAction(connectionId, userId, toolId, args);
    const action = await prisma.actionRequest.create({
      data: {
        traceId: trace,
        userId,
        connectionId,
        toolId,
        action: toolId,
        riskLevel: riskForTool(toolId),
        status: result.ok ? 'executed' : 'failed',
        preview: JSON.stringify(buildPreview(toolId, args)),
        requestedBy,
        decidedBy: requestedBy,
        result: JSON.stringify({ ok: result.ok, verified: result.verified, data: result.data ?? null, error: result.error || null }),
      },
    });
    await addEvent(trace, 'TOOL', { toolId, ok: result.ok, verified: result.verified }, result.ok ? 'success' : 'error');
    return { executed: true, status: 'executed' as const, result: result as any, actionId: action.id };
  }

  // 2. Deny
  if (check.decision === 'deny') {
    const action = await prisma.actionRequest.create({
      data: {
        traceId: trace,
        userId,
        connectionId,
        toolId,
        action: toolId,
        riskLevel: riskForTool(toolId),
        status: 'rejected',
        preview: JSON.stringify(buildPreview(toolId, args)),
        requestedBy,
        result: JSON.stringify({ denied: true, reason: check.reason || 'Denied by policy' }),
      },
    });
    return { executed: false, actionId: action.id, status: 'denied', reason: check.reason || 'Denied by policy' };
  }

  // 3. Needs approval
  const action = await prisma.actionRequest.create({
    data: {
      traceId: trace,
      userId,
      connectionId,
      toolId,
      action: toolId,
      riskLevel: riskForTool(toolId),
      status: 'pending',
      preview: JSON.stringify(buildPreview(toolId, args)),
      requestedBy,
    },
  });
  await addEvent(trace, 'PERMISSION', { toolId, riskLevel: riskForTool(toolId), decision: 'confirm', actionId: action.id }, 'pending');
  return { executed: false, actionId: action.id, status: 'pending', preview: action.preview };
}

/**
 * Approve a pending action. Re-checks permissions (policy may have
 * changed since the request was created). TTL: pending requests older
 * than 30 minutes are expired.
 */
export async function approveAction(
  userId: string,
  actionId: string,
  decidedBy?: string,
): Promise<{ executed: boolean; result?: unknown; error?: string }> {
  const action = await prisma.actionRequest.findFirst({ where: { id: actionId, userId } });
  if (!action) throw new Error('Action not found');
  if (action.status !== 'pending') {
    return { executed: false, error: `Action already ${action.status}` };
  }
  if (Date.now() - action.createdAt.getTime() > ACTION_TTL_MS) {
    await prisma.actionRequest.update({ where: { id: action.id }, data: { status: 'expired' } });
    return { executed: false, error: 'Action expired' };
  }

  const conn = await prisma.connection.findFirst({ where: { id: action.connectionId, userId } });
  const check = await checkPermission({
    userId,
    riskLevel: action.riskLevel as RiskLevel,
    requiredCapability: requiredCapabilityForTool(action.toolId),
    connection: { ...conn, permissions: JSON.parse(conn.permissions || '[]'), scopes: JSON.parse(conn.scopes || '[]') } as any,
  });
  if (check.decision === 'deny') {
    await prisma.actionRequest.update({ where: { id: action.id }, data: { status: 'rejected', decidedBy } });
    return { executed: false, error: check.reason || 'Now denied by policy' };
  }

  const preview = JSON.parse(action.preview || '{}');
  const result = await executeAction(action.connectionId!, userId, action.toolId, preview.args);
  await prisma.actionRequest.update({
    where: { id: action.id },
    data: {
      status: result.ok ? 'executed' : 'failed',
      decidedBy,
      result: JSON.stringify({ ok: result.ok, verified: result.verified, data: result.data ?? null, error: result.error || null }),
    },
  });
  if (action.traceId) {
    await addEvent(action.traceId, 'APPROVAL', { actionId, ok: result.ok, verified: result.verified, decidedBy }, result.ok ? 'success' : 'error');
  }
  return { executed: true, result };
}

export async function rejectAction(userId: string, actionId: string, decidedBy?: string, reason?: string) {
  const action = await prisma.actionRequest.findFirst({ where: { id: actionId, userId } });
  if (!action) throw new Error('Action not found');
  if (action.status !== 'pending') return { error: `Action already ${action.status}` };
  await prisma.actionRequest.update({
    where: { id: action.id },
    data: { status: 'rejected', decidedBy, result: JSON.stringify({ denied: true, reason: reason || 'Rejected by user' }) },
  });
  await addEvent(action.traceId || '', 'APPROVAL', { actionId, rejected: true, decidedBy, reason }, 'denied');
  return { ok: true };
}

export async function listPendingActions(userId: string) {
  const now = Date.now();
  const pending = await prisma.actionRequest.findMany({
    where: { userId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
  });
  return pending.map((a) => ({
    ...a,
    expired: now - a.createdAt.getTime() > ACTION_TTL_MS,
  }));
}

/** Provider & tool metadata helpers for API responses */
export function providerCapabilitiesView(providerId: string) {
  const p = getProvider(providerId);
  if (!p) return null;
  return {
    id: p.providerId,
    displayName: p.displayName,
    type: p.apiSupported ? 'api' : p.oauthSupported ? 'oauth' : 'browser',
    status: p.apiSupported || p.oauthSupported ? 'active' : 'stub',
    authMethods: (p.oauthSupported ? ['oauth'] : p.apiKeySupported ? ['api_key'] : []) as any,
    capabilities: (p.capabilities || []).map((c: any) => ({ id: c.id, label: c.label, riskLevel: c.riskLevel, readOnly: c.readOnly })),
  };
}

export function toolView(toolId: string) {
  const t = getTool(toolId);
  if (!t) return null;
  return t;
}
