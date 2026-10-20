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
import { R, fromLegacy } from './contract';
import type { ConnectorResult } from './connectors/base';
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

// P0-1: 旧联合只有 executed/pending/denied 三种，导致失败被硬塞进 executed:true。
// 现在增加明确的失败终态，并把 result 的真实 status 一并带回，让调用方（路由
// 与后续 Agent）能区分「明确失败」「结果未知」「能力未实现」「需要授权」。
export type CreateActionResult =
  | { executed: true; status: 'executed'; result: unknown; resultStatus: 'success'; actionId: string }
  | { executed: false; actionId: string; status: 'pending'; preview: unknown }
  | { executed: false; actionId: string; status: 'denied'; reason: string }
  | { executed: false; actionId: string; status: 'failed'; result: unknown; resultStatus: Exclude<ConnectorResult['status'], 'success'>; reason: string }
  | { executed: false; actionId: string; status: 'verifying'; result: unknown; resultStatus: 'unknown'; reason: string }
  | { executed: false; actionId: string; status: 'waiting_auth'; result: unknown; resultStatus: 'auth_required'; reason: string };

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
): Promise<ConnectorResult> {
  // P0-2: Unified execution — no dual-path。返回类型统一为 ConnectorResult，
  // 使上层（createAction/approveAction）能区分明确失败、未知与未实现。
  const conn = await prisma.connection.findFirst({ where: { id: connectionId, userId }, select: { providerId: true, credentialRef: true, account: true, authMethod: true } });
  if (!conn) return R.fail('Connection not found');

  // 1. Try native adapter first (GitHub, etc.)
  if (GITHUB_TOOLS[toolId]) {
    // GitHub 原生适配器已改用 ConnectorResult（executeGitHubTool 的
    // ToolResult 现为 ConnectorResult 别名），无需再经旧形状转换。
    const result = await executeGitHubTool({ connectionId, userId, toolId, args });
    return result;
  }

  // 2. Use universal connector with precise capability matching
  const selection = selectConnector(conn.providerId, toolId, { _authMethod: conn.authMethod });
  if (!selection) return R.fail(`No connector for ${conn.providerId}/${toolId}`);

  const ctx = {
    userId,
    connectionId,
    credentialId: conn.credentialRef || '',
    accountId: conn.account || undefined,
    traceId: undefined,
    requestId: undefined,
  };

  try {
    // 旧版在此把连接器结果拍平成旧形状，丢失 status 语义。
    // 现在 executeAction 整体改用 ConnectorResult，失败/未知/未实现分类直达上层。
    return await selection.connector.execute(ctx, toolId, args);
  } catch (err: any) {
    return R.fail(err?.message || String(err));
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
    const result: ConnectorResult = await executeAction(connectionId, userId, toolId, args);
    // P0-1: 旧版一律 `result.ok ? 'executed' : 'failed'`，且返回体恒为
    // executed:true —— 调用方拿到失败还以为执行成功。按真实 status 分流。
    const succeeded = result.status === 'success';
    const persistedStatus = succeeded ? 'executed'
      : result.status === 'unknown' ? 'verifying'
      : result.status === 'auth_required' ? 'waiting_auth'
      : 'failed';
    const action = await prisma.actionRequest.create({
      data: {
        traceId: trace,
        userId,
        connectionId,
        toolId,
        action: toolId,
        riskLevel: riskForTool(toolId),
        status: persistedStatus,
        preview: JSON.stringify(buildPreview(toolId, args)),
        requestedBy,
        decidedBy: requestedBy,
        result: JSON.stringify({
          status: result.status,
          verified: succeeded ? !!result.verified : false,
          data: (result as any).data ?? null,
          error: succeeded ? null : result.error,
        }),
      },
    });
    await addEvent(trace, 'TOOL',
      { toolId, status: result.status, verified: succeeded ? !!result.verified : false },
      succeeded ? 'success' : result.status === 'unknown' ? 'unknown' : 'error');
    // 失败终态把真实 status 与原因一并带回，调用方不再只能看到 executed:false。
    if (succeeded) {
      return { executed: true, status: 'executed', resultStatus: 'success', result: result as any, actionId: action.id };
    }
    const rs = result.status;
    const reason = result.error;
    const terminal = rs === 'unknown' ? 'verifying'
      : rs === 'auth_required' ? 'waiting_auth'
      : 'failed';
    return {
      executed: false,
      status: terminal as any,
      resultStatus: rs as any,
      result: result as any,
      reason,
      actionId: action.id,
    } as any;
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
    // P1-c: 用 updateMany + status:'pending' 作为条件做原子 CAS。
    // 旧版的先查后写没有原子性：两个并发的 approve 请求都能读到
    // status==='pending'，随后都执行 —— 同一授权被执行两遍。
    // 这里只有真正把状态从 pending 推走的那个请求能继续。
    const claimed = await prisma.actionRequest.updateMany({
      where: { id: action.id, status: 'pending' },
      data: { status: 'expired' },
    });
    if (claimed.count === 0) {
      return { executed: false, error: 'Action already handled by another request' };
    }
    return { executed: false, error: 'Action expired' };
  }

  const conn = await prisma.connection.findFirst({ where: { id: action.connectionId, userId } });
  // P1-a: 旧版在此直接读 conn.permissions —— 若连接在请求创建后已被删除，
  // conn 为 undefined，这里抛 TypeError，用户看到的是 500 而非可理解的原因。
  if (!conn) {
    await prisma.actionRequest.update({ where: { id: action.id }, data: { status: 'failed', decidedBy, result: JSON.stringify({ status: 'failure', error: 'Connection no longer exists' }) } });
    return { executed: false, error: 'Connection no longer exists' };
  }
  const check = await checkPermission({
    userId,
    riskLevel: action.riskLevel as RiskLevel,
    requiredCapability: requiredCapabilityForTool(action.toolId),
    connection: { ...conn, permissions: JSON.parse(conn.permissions || '[]'), scopes: JSON.parse(conn.scopes || '[]') } as any,
  });
  // P1-b: 旧版只拦 deny。若等待期间策略从 never 改成 confirm，会直接执行，
  // 把"需要再次确认"降级成"已获批准"，优先级倒挂。confirm 一律回绝，
  // 让用户在新策略下重新发起。
  if (check.decision !== 'allow') {
    const reason = check.decision === 'deny'
      ? (check.reason || 'Now denied by policy')
      : 'Policy changed — this action now requires a fresh confirmation';
    await prisma.actionRequest.update({ where: { id: action.id }, data: { status: 'rejected', decidedBy, result: JSON.stringify({ denied: true, reason }) } });
    return { executed: false, error: reason };
  }

  const preview = JSON.parse(action.preview || '{}');
  // P1-c: 执行前原子抢占。把 status 从 pending 改为 'approved_claimed' 这一
  // 中间态：只有 CAS 成功的那个请求才会真正调用连接器。旧版在权限检查通过后
  // 就直接 executeAction，两个并发批准会各自执行一次外部副作用（发消息、
  // 写仓库），且 update 无条件写入会把先完成的结果覆盖掉。
  const claim = await prisma.actionRequest.updateMany({
    where: { id: action.id, status: 'pending' },
    data: { status: 'approved', decidedBy },
  });
  if (claim.count === 0) {
    return { executed: false, error: 'Action already handled by another request' };
  }
  try {
    return await executeApproved(action, preview.args, decidedBy);
  } catch (err: any) {
    // 执行本身抛错（而非返回失败结果）时也要留下终态，否则会永远停在 approved。
    const result = R.fail(err?.message || String(err));
    await prisma.actionRequest.update({
      where: { id: action.id },
      data: { status: 'failed', result: JSON.stringify({ status: result.status, error: (result as any).error }) },
    });
    throw err;
  }
}

/** 已被原子抢占的 ActionRequest 的实际执行与结果持久化。 */
async function executeApproved(action: any, args: any, decidedBy?: string) {
  const result = await executeAction(action.connectionId!, action.userId, action.toolId, args);
  // P0-1: 旧版一律写成 `result.ok ? 'executed' : 'failed'`，把「结果未知」和
  // 「能力未实现」也压成明确失败 —— 上层无法知道该重试还是该人工介入。
  // ActionRequest.status 枚举本来就有 waiting_auth / verifying，这里如实分流。
  const persistedStatus = result.status === 'success' ? 'executed'
    : result.status === 'unknown' ? 'verifying'
    : result.status === 'auth_required' ? 'waiting_auth'
    : result.status === 'not_implemented' || result.status === 'unavailable' ? 'failed'
    : 'failed';
  await prisma.actionRequest.update({
    where: { id: action.id },
    data: {
      status: persistedStatus,
      decidedBy,
      result: JSON.stringify({
        status: result.status,
        verified: result.status === 'success' ? !!result.verified : false,
        data: (result as any).data ?? null,
        error: result.status === 'success' ? null : result.error,
      }),
    },
  });
  if (action.traceId) {
    const ok = result.status === 'success';
    await addEvent(action.traceId, 'APPROVAL',
      { actionId: action.id, status: result.status, verified: ok ? !!(result as any).verified : false, decidedBy },
      ok ? 'success' : result.status === 'unknown' ? 'unknown' : 'error');
  }
  return { executed: result.status === 'success', result };
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
