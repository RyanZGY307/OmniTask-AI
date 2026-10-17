// ================================================================
// Universal Connect Runtime v2 — Generic Token Connector
//
// Lets a user hand the platform ANY account token and have the AI use it
// to operate that account. Supports many token kinds (支持种类多):
//   bearer / oauth_access  → Authorization: Bearer
//   api_key               → named header (X-API-Key etc.) or Bearer
//   basic                 → Authorization: Basic base64(user:pass)
//   cookie                → Cookie: <session>
//   custom                → <headerName>: <value>
// The token is stored ENCRYPTED in the credential vault (never logged or
// returned in tool results); only redacted metadata is exposed.
// ================================================================

import { BaseConnector, ConnectorContext, ConnectorResult } from './base';
import { getSecret, storeCredential, revokeCredential } from '../vault';
import { prisma } from '../../services/db';
import { PROVIDER_BASE_URLS } from '../../config';

export type TokenKind = 'bearer' | 'oauth_access' | 'api_key' | 'basic' | 'cookie' | 'custom';

const TOKEN_KINDS: TokenKind[] = ['bearer', 'oauth_access', 'api_key', 'basic', 'cookie', 'custom'];

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY = 5000;

interface StoredToken {
  token: string;
  kind: TokenKind;
  headerName?: string; // for api_key / custom
  apiKeyParam?: string; // for api_key via query
  baseUrl?: string;
  authUser?: string; // for basic
}

function parseStored(raw: string): StoredToken | null {
  try {
    const s = JSON.parse(raw) as StoredToken;
    if (!s || typeof s.token !== 'string' || !s.token) return null;
    return s;
  } catch {
    return null;
  }
}

function buildHeaders(st: StoredToken, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra || {}) };
  switch (st.kind) {
    case 'bearer':
    case 'oauth_access':
      h.Authorization = `Bearer ${st.token}`;
      break;
    case 'basic':
      h.Authorization = `Basic ${Buffer.from(`${st.authUser || ''}:${st.token}`).toString('base64')}`;
      break;
    case 'cookie':
      h.Cookie = st.token;
      break;
    case 'api_key':
      if (st.headerName) h[st.headerName] = st.token;
      else h.Authorization = `Bearer ${st.token}`;
      break;
    case 'custom':
      if (st.headerName) h[st.headerName] = st.token;
      break;
  }
  return h;
}

async function fetchTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class TokenConnector extends BaseConnector {
  readonly type = 'api' as const;
  readonly name = 'Generic Token Connector';

  // Reuses the 'api' connector lane (selectConnector routes api/oauth auth).
  // Only this connector claims 'web.token.request', so routing is unambiguous.
  readonly supportedCapabilities = [
    {
      capabilityId: 'web.token.request',
      toolIds: ['web-token.request', 'web-token.get', 'web-token.post'],
      connectorType: 'api' as const,
      authMethod: 'api_key',
      riskLevel: 'R2' as const,
      readOnly: false,
      regions: ['global'],
    },
  ] as any[];

  readonly requiredAuthMethod = 'api_key';
  readonly defaultRiskLevel = 'R2' as const;

  /**
   * Store a user-supplied token. `input`:
   *   { token, tokenKind?, headerName?, apiKeyParam?, baseUrl?, authUser? }
   */
  async authenticate(
    ctx: ConnectorContext,
    input: Record<string, any>,
  ): Promise<{ credentialId: string; accountId?: string; accountName?: string; sessionToken?: string }> {
    const token = String(input.token ?? input.apiKey ?? input.accessToken ?? '').trim();
    if (!token) throw new Error('Token is required');
    const kind: TokenKind = TOKEN_KINDS.includes(input.tokenKind as TokenKind)
      ? (input.tokenKind as TokenKind)
      : 'bearer';

    const providerId = input.providerId || ctx.credentialId || 'generic-token';
    const conn = await prisma.connection.findFirst({ where: { id: ctx.connectionId }, select: { providerId: true } });
    const resolvedProvider = conn?.providerId || providerId;

    const stored: StoredToken = {
      token,
      kind,
      headerName: input.headerName ? String(input.headerName) : undefined,
      apiKeyParam: input.apiKeyParam ? String(input.apiKeyParam) : undefined,
      baseUrl: input.baseUrl ? String(input.baseUrl) : undefined,
      authUser: input.authUser ? String(input.authUser) : undefined,
    };

    const credentialId = await storeCredential(
      ctx.userId,
      resolvedProvider,
      'generic_token',
      JSON.stringify(stored),
      { tokenKind: kind, baseUrl: stored.baseUrl || null },
    );

    await prisma.connection.updateMany({
      where: { id: ctx.connectionId, userId: ctx.userId },
      data: { status: 'active', credentialRef: credentialId, lastTokenRefresh: new Date() },
    });

    return { credentialId, accountName: `${resolvedProvider} (token)`, sessionToken: kind };
  }

  async execute(ctx: ConnectorContext, toolId: string, args: Record<string, any>): Promise<ConnectorResult> {
    const norm = String(toolId).replace(/^web-token\./, ''); // request | get | post
    const method = norm === 'post' ? 'POST' : norm === 'get' ? 'GET' : (String(args.method || 'GET').toUpperCase());

    const conn = await prisma.connection.findFirst({
      where: { id: ctx.connectionId, userId: ctx.userId },
      select: { credentialRef: true, providerId: true },
    });
    if (!conn?.credentialRef) return { ok: false, verified: false, error: 'No token configured for this connection' };

    const secret = await getSecret(conn.credentialRef, ctx.userId);
    const st = secret ? parseStored(secret) : null;
    if (!st) return { ok: false, verified: false, error: 'Failed to decrypt stored token' };

    const baseUrl = st.baseUrl || args.baseUrl || PROVIDER_BASE_URLS[conn.providerId as keyof typeof PROVIDER_BASE_URLS] || '';
    const target = args.url || (baseUrl && args.path ? `${baseUrl.replace(/\/$/, '')}${args.path}` : baseUrl);
    if (!target) return { ok: false, verified: false, error: 'No target URL (provide url or baseUrl+path)' };

    let url = target;
    const headers = buildHeaders(st, args.headers);
    if (st.kind === 'api_key' && st.apiKeyParam) {
      const u = new URL(url);
      if (!u.searchParams.has(st.apiKeyParam)) u.searchParams.set(st.apiKeyParam, st.token);
      url = u.toString();
    }

    const init: RequestInit = { method, headers };
    if (method === 'POST' && args.body !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      init.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
    }

    let res: Response;
    try {
      res = await fetchTimeout(url, init);
    } catch (err: any) {
      return { ok: false, verified: false, error: `Request failed: ${err?.message || err}` };
    }

    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '';
    }
    let parsed: any = undefined;
    try {
      parsed = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      parsed = undefined;
    }

    // Never surface the token; expose status + a truncated body.
    return {
      ok: res.ok,
      verified: res.ok,
      data: {
        status: res.status,
        ok: res.ok,
        body: parsed !== undefined ? parsed : bodyText.slice(0, MAX_BODY),
        truncated: bodyText.length > MAX_BODY,
      },
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  }

  async refresh(_ctx: ConnectorContext): Promise<void> {
    // User-supplied tokens don't auto-refresh; re-authenticate with a new token.
  }

  async revoke(ctx: ConnectorContext): Promise<void> {
    const conn = await prisma.connection.findUnique({ where: { id: ctx.connectionId } });
    if (conn?.credentialRef) await revokeCredential(conn.credentialRef, ctx.userId);
    await prisma.connection.update({ where: { id: ctx.connectionId }, data: { status: 'revoked' } });
  }

  async healthCheck(ctx: ConnectorContext): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const conn = await prisma.connection.findFirst({ where: { id: ctx.connectionId, userId: ctx.userId }, select: { credentialRef: true, providerId: true } });
    if (!conn?.credentialRef) return { ok: false, error: 'No token' };
    const secret = await getSecret(conn.credentialRef, ctx.userId);
    const st = secret ? parseStored(secret) : null;
    if (!st) return { ok: false, error: 'Failed to decrypt token' };
    const baseUrl = st.baseUrl || PROVIDER_BASE_URLS[conn.providerId as keyof typeof PROVIDER_BASE_URLS];
    if (!baseUrl) return { ok: false, error: 'No endpoint for health check' };
    const start = Date.now();
    try {
      const res = await fetchTimeout(baseUrl, { method: 'GET', headers: buildHeaders(st) });
      return { ok: res.ok, latencyMs: Date.now() - start, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err: any) {
      return { ok: false, error: err?.message };
    }
  }
}

export const tokenConnector = new TokenConnector();
export { TOKEN_KINDS };
