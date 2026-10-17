// ================================================================
// Connections API
//   GET    /api/connections
//   POST   /api/connections/:provider/connect   (method: api | oauth)
//   POST   /api/connections/:provider/oauth/start
//   GET    /api/connections/policy
//   PUT    /api/connections/policy
//   GET    /api/connections/:id
//   DELETE /api/connections/:id
// ================================================================

import { Router, Request, Response } from 'express';
import { prisma } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { storeCredential, revokeCredential, credentialStatus } from '../connections/vault';
import { getProvider, providerCapabilities } from '../connections/providers';
import { browserConnector } from '../connections/connectors/browser';
import { tokenConnector } from '../connections/connectors/token';
import { verifyToken, checkRepoPermissions, GitHubAuthError } from '../connections/github';
import { getPolicy, setPolicy } from '../connections/permissionEngine';
import { addEvent } from '../services/trace';
import { createTrace, newTraceId, newRequestId } from '../services/trace';

const router = Router();

async function traceFor(userId: string): Promise<string> {
  const traceId = newTraceId();
  await createTrace({ traceId, requestId: newRequestId(), userId });
  return traceId;
}

// ---- list ----
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const connections = await prisma.connection.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  const view = await Promise.all(connections.map(async (c) => {
    let credentialState: string | null = null;
    if (c.credentialRef) credentialState = await credentialStatus(c.credentialRef);
    const status = credentialState === 'revoked' && c.status === 'active' ? 'revoked' : c.status;
    return {
      id: c.id,
      providerId: c.providerId,
      type: c.type,
      authMethod: c.authMethod,
      status,
      permissions: JSON.parse(c.permissions || '[]'),
      scopes: JSON.parse(c.scopes || '[]'),
      credentialRef: c.credentialRef,
      credentialState,
      account: c.account,
      owner: c.owner,
      repo: c.repo,
      createdAt: c.createdAt,
      provider: providerCapabilities(c.providerId),
    };
  }));
  const policy = await getPolicy(userId);
  res.json({ connections: view, policy });
});

// ---- policy ----
router.get('/policy', authMiddleware, async (req: AuthRequest, res: Response) => {
  const policy = await getPolicy(req.user!.id);
  res.json({ policy });
});

router.put('/policy', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const policy = await setPolicy(userId, req.body?.policy);
  const traceId = await traceFor(userId);
  await addEvent(traceId, 'PERMISSION', { updated: policy }, 'success');
  res.json({ policy });
});

// ---- generic browser login (web) / multi-token connect (web-token) ----
// 登录任意网站（账号/密码/验证码）或提供账号 token；存金库，供 AI 后续操作。
// 必须定义在 `/:provider/connect` 之前，否则会被参数路由拦截。
router.post('/web/connect', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const providerId = String(req.body?.providerId || 'web');
  const traceId = await traceFor(userId);
  try {
    let conn = await prisma.connection.findFirst({ where: { userId, providerId } });
    if (!conn) {
      conn = await prisma.connection.create({
        data: { userId, providerId, type: 'browser', authMethod: 'browser_session', status: 'connecting', permissions: '[]', scopes: '[]' },
      });
    }
    const out = await browserConnector.authenticate({ userId, connectionId: conn.id, credentialId: conn.credentialRef || '' }, {
      providerId, url: req.body?.url, username: req.body?.username, password: req.body?.password,
      otp: req.body?.otp ?? req.body?.captchaCode ?? req.body?.mfaCode, profile: req.body?.profile,
    });
    await prisma.connection.update({
      where: { id: conn.id },
      data: { credentialRef: out.credentialId, status: out.waitingCaptcha ? 'reauth_required' : 'active', account: req.body?.username ? String(req.body.username) : conn.account, sessionId: out.sessionToken || null },
    });
    await addEvent(traceId, 'CONNECTION', { provider: providerId, kind: 'browser-login', waitingCaptcha: !!out.waitingCaptcha, account: req.body?.username || null }, out.waitingCaptcha ? 'pending' : 'active');
    res.json({ ok: true, connection: { id: conn.id, providerId, status: out.waitingCaptcha ? 'reauth_required' : 'active' }, waitingCaptcha: !!out.waitingCaptcha, credentialId: out.credentialId });
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Browser login failed' });
  }
});

router.post('/web-token/connect', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const providerId = String(req.body?.providerId || 'web-token');
  const traceId = await traceFor(userId);
  try {
    let conn = await prisma.connection.findFirst({ where: { userId, providerId } });
    if (!conn) {
      conn = await prisma.connection.create({
        data: { userId, providerId, type: 'api', authMethod: 'api_key', status: 'connecting', permissions: '[]', scopes: '[]' },
      });
    }
    const out = await tokenConnector.authenticate({ userId, connectionId: conn.id, credentialId: conn.credentialRef || '' }, {
      providerId, token: req.body?.token ?? req.body?.apiKey, tokenKind: req.body?.tokenKind,
      headerName: req.body?.headerName, apiKeyParam: req.body?.apiKeyParam, baseUrl: req.body?.baseUrl, authUser: req.body?.authUser,
    });
    await addEvent(traceId, 'CONNECTION', { provider: providerId, kind: 'token', tokenKind: req.body?.tokenKind || 'bearer' }, 'active');
    res.json({ ok: true, connection: { id: conn.id, providerId, status: 'active' }, credentialId: out.credentialId, tokenKind: out.sessionToken });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Token connect failed' });
  }
});

// ---- connect ----
router.post('/:provider/connect', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const provider = getProvider(String(req.params.provider));
  if (!provider) { res.status(404).json({ error: 'Unknown provider' }); return; }
  if ((provider as any).apiSupported || (provider as any).oauthSupported || provider.providerId !== 'github') {
    res.status(501).json({ error: `Provider ${provider.providerId} not yet available` });
    return;
  }

  const method = req.body?.method || 'api';
  const traceId = await traceFor(userId);

  let token: string | null = null;

  if (method === 'oauth' && req.body?.code) {
    token = await exchangeGithubCode(String(req.body.code));
    if (!token) { res.status(400).json({ error: 'OAuth code exchange failed' }); return; }
  } else if (method === 'api' && typeof req.body?.token === 'string' && req.body.token.trim()) {
    token = req.body.token.trim();
  } else {
    res.status(400).json({ error: 'Provide { method: "api", token } or { method: "oauth", code }' });
    return;
  }

  // Verify the token before storing
  let login: string;
  try {
    const v = await verifyToken(token);
    login = v.login;
  } catch (err: any) {
    if (err instanceof GitHubAuthError) {
      res.status(401).json({ error: `Token ${err.kind}: ${err.message}` });
      return;
    }
    res.status(502).json({ error: 'Failed to verify GitHub token' });
    return;
  }

  const owner: string | null = req.body?.owner && String(req.body.owner).trim() ? String(req.body.owner) : login;
  const repo: string | null = req.body?.repo && String(req.body.repo).trim() ? String(req.body.repo) : null;

  // Derive the permission set from real repo access level — no speculative grants
  const caps = (provider as any).capabilities?.map((c: any) => c.id) || [];
  let granted = caps.filter((c) => c.endsWith('.read') || c === 'repository.read');
  if (repo) {
    const perm = await checkRepoPermissions(token, owner, repo).catch(() => null);
    if (perm && perm.push) {
      granted = caps; // read + write set
    }
  }

  const credentialRef = await storeCredential(userId, 'github', method === 'oauth' ? 'github_oauth' : 'github_pat', token, {
    login,
    owner,
    repo,
  });

  const existing = await prisma.connection.findFirst({ where: { userId, providerId: 'github', account: login } });
  const conn = existing
    ? await prisma.connection.update({
        where: { id: existing.id },
        data: { status: 'active', authMethod: method, permissions: JSON.stringify(granted), credentialRef, owner, repo, meta: JSON.stringify({ updatedBy: 'connect' }) },
      })
    : await prisma.connection.create({
        data: {
          userId,
          providerId: 'github',
          type: method === 'oauth' ? 'oauth' : 'api',
          authMethod: method,
          status: 'active',
          permissions: JSON.stringify(granted),
          scopes: JSON.stringify(caps),
          credentialRef,
          account: login,
          owner,
          repo,
        },
      });

  await addEvent(traceId, 'CONNECTION', {
    provider: 'github', method, account: login, owner, repo, permissions: granted, connectionId: conn.id,
  }, 'active');

  res.json({
    connection: {
      id: conn.id,
      providerId: conn.providerId,
      status: conn.status,
       account: conn.account,
       owner: conn.owner,
       repo: conn.repo,
       permissions: JSON.parse(conn.permissions || '[]'),
       credentialRef: conn.credentialRef,
     },
    traceId,
  });
});

// ---- oauth start ----
router.post('/:provider/oauth/start', authMiddleware, async (req: AuthRequest, res: Response) => {
  const provider = getProvider(String(req.params.provider));
  if (!provider || provider.providerId !== 'github') { res.status(404).json({ error: 'Provider does not support OAuth start' }); return; }
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(501).json({ error: 'GitHub OAuth not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET missing). Use API token instead.' });
    return;
  }
  const redirectUri = process.env.GITHUB_OAUTH_REDIRECT_URI;
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', 'repo read org read');
  if (redirectUri) url.searchParams.set('redirect_uri', redirectUri);
  res.json({ url: url.toString() });
});

async function exchangeGithubCode(code: string): Promise<string | null> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  if (!res.ok) return null;
  const body: any = await res.json().catch(() => null);
  return body?.access_token || null;
}

// ---- detail / delete ----
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  const conn = await prisma.connection.findFirst({ where: { id: String(req.params.id), userId: req.user!.id } });
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }
  const credentialState = conn.credentialRef ? await credentialStatus(conn.credentialRef) : null;
  res.json({
    id: conn.id,
    providerId: conn.providerId,
    type: conn.type,
    authMethod: conn.authMethod,
    status: conn.status,
    permissions: JSON.parse(conn.permissions || '[]'),
    account: conn.account,
    owner: conn.owner,
    repo: conn.repo,
    credentialRef: conn.credentialRef,
    credentialState,
    createdAt: conn.createdAt,
  });
});

router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const conn = await prisma.connection.findFirst({ where: { id: String(req.params.id), userId } });
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }
  await prisma.connection.update({ where: { id: conn.id }, data: { status: 'revoked' } });
  if (conn.credentialRef) await revokeCredential(conn.credentialRef, userId);
  const traceId = await traceFor(userId);
  await addEvent(traceId, 'CONNECTION', { connectionId: conn.id, provider: conn.providerId, revoked: true }, 'revoked');
  res.json({ ok: true });
});

export default router;
