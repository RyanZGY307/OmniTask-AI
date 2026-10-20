// ================================================================
// GitHub First-party Connector
// Every external operation:
//   Connection (credentialRef) → decrypt token → tool call → GitHub API → read-back verification
// Secrets never leave this module in plaintext; only structured
// results (without tokens) are returned.
// ================================================================

import { prisma } from '../services/db';
import { getSecret } from './vault';
import { ExecutionResult } from './types';
import { R } from './contract';
import type { ConnectorResult } from './connectors/base';

const GITHUB_API = process.env.GITHUB_API_BASE || 'https://api.github.com';

export class GitHubAuthError extends Error {
  constructor(public readonly kind: 'expired' | 'revoked', message: string) {
    super(message);
  }
}

export class GitHubActionError extends Error {
  constructor(message: string, public readonly httpStatus?: number) {
    super(message);
  }
}

interface GhsResponse {
  ok: boolean;
  status: number;
  body: any;
}

async function ghFetch(token: string, method: string, path: string, body?: unknown): Promise<GhsResponse> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  if (res.status === 401) {
    const msg = parsed?.message || 'unauthorized';
    throw new GitHubAuthError(/bad_credentials|bad_credentials/.test(msg) ? 'revoked' : 'expired', msg);
  }
  if (res.status === 403 && (parsed?.message === 'Bad credentials' || parsed?.message === 'Bad credentials.')) {
    throw new GitHubAuthError('revoked', parsed.message);
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

function mapStatus(status: number, message: string): never {
  throw new GitHubActionError(`GitHub API ${status}: ${message}`, status);
}

/** Verify token: GET /user → account + login. Throws GitHubAuthError. */
export async function verifyToken(token: string): Promise<{ login: string; name?: string; id: number }> {
  const r = await ghFetch(token, 'GET', '/user');
  if (!r.ok) mapStatus(r.status, r.body?.message || 'failed to verify token');
  return { login: r.body.login, name: r.body.name, id: r.body.id };
}

/** Check repo access level for a given owner/repo. */
export async function checkRepoPermissions(token: string, owner: string, repo: string): Promise<{ pull: boolean; push: boolean; admin: boolean }> {
  const r = await ghFetch(token, 'GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  if (!r.ok) return { pull: false, push: false, admin: false };
  const p = r.body?.permissions || {};
  return { pull: !!p.pull, push: !!p.push, admin: !!p.admin };
}

export type ToolContext = {
  token: string;
  owner: string;
  repo: string;
};

// P0-1: ToolResult 不再自造 ok/verified/error 三字段旧形状 —— 那正是
// 「成功带 error」「失败被吞成成功」的类型根源。统一改用 contract.ts 的
// ConnectorResult 判别联合（成功分支无 error，失败分支必带 error）。
export type ToolResult = ConnectorResult;

export const GITHUB_TOOLS: Record<string, {
  description: string;
  requiredCapabilities: string[];
  riskLevel: 'R0' | 'R1' | 'R2';
  readOnly: boolean;
  execute: (ctx: ToolContext, args: any) => Promise<ToolResult>;
}> = {
  'github.repo.read': {
    description: 'Read repository metadata',
    requiredCapabilities: ['repository.read'],
    riskLevel: 'R0',
    readOnly: true,
    async execute(ctx, args) {
      const path = args?.path ? `/contents/${args.path}` : '';
      const r = await ghFetch(ctx.token, 'GET', `/repos/${ctx.owner}/${ctx.repo}${path}`);
      if (!r.ok) return R.fail(`HTTP ${r.status}: ${r.body?.message}`);
      return R.success(r.body, true);
    },
  },
  'github.issue.read': {
    description: 'Read issues list',
    requiredCapabilities: ['issue.read'],
    riskLevel: 'R0',
    readOnly: true,
    async execute(ctx, args) {
      const r = await ghFetch(ctx.token, 'GET', `/repos/${ctx.owner}/${ctx.repo}/issues?per_page=${args?.perPage || 30}&state=${args?.state || 'all'}`);
      if (!r.ok) return R.fail(`HTTP ${r.status}: ${r.body?.message}`);
      return R.success(r.body, true);
    },
  },
  'github.issue.create': {
    description: 'Create an issue',
    requiredCapabilities: ['issue.write'],
    riskLevel: 'R1',
    readOnly: false,
    async execute(ctx, args) {
      if (!args?.title) return R.fail('title is required');
      const r = await ghFetch(ctx.token, 'POST', `/repos/${ctx.owner}/${ctx.repo}/issues`, {
        title: args.title, body: args.body || '', labels: args.labels || [],
      });
      if (!r.ok) return R.fail(`HTTP ${r.status}: ${r.body?.message}`);
      const created = await ghFetch(ctx.token, 'GET', `/repos/${ctx.owner}/${ctx.repo}/issues/${r.body.number}`);
      const verified = created.ok && created.body?.state === 'open';
      return R.success(verified ? { number: created.body.number, title: created.body.title, state: created.body.state } : { number: r.body.number }, verified);
    },
  },
  'github.pr.read': {
    description: 'Read pull requests',
    requiredCapabilities: ['pull_request.read'],
    riskLevel: 'R0',
    readOnly: true,
    async execute(ctx, args) {
      const r = await ghFetch(ctx.token, 'GET', `/repos/${ctx.owner}/${ctx.repo}/pulls?per_page=${args?.perPage || 20}&state=${args?.state || 'open'}`);
      if (!r.ok) return R.fail(`HTTP ${r.status}: ${r.body?.message}`);
      return R.success(r.body, true);
    },
  },
  'github.pr.create': {
    description: 'Create a pull request',
    requiredCapabilities: ['pull_request.write'],
    riskLevel: 'R2',
    readOnly: false,
    async execute(ctx, args) {
      if (!args?.title || !args?.head || !args?.base) {
        return R.fail('title, head and base are required');
      }
      const r = await ghFetch(ctx.token, 'POST', `/repos/${ctx.owner}/${ctx.repo}/pulls`, {
        title: args.title, head: args.head, base: args.base, body: args.body || '',
      });
      if (!r.ok) return R.fail(`HTTP ${r.status}: ${r.body?.message}`);
      const created = await ghFetch(ctx.token, 'GET', `/repos/${ctx.owner}/${ctx.repo}/pulls/${r.body.number}`);
      const verified = created.ok && created.body?.state === 'open';
      return R.success(verified ? { number: created.body.number, title: created.body.title, state: created.body.state, url: created.body.html_url } : { number: r.body.number }, verified);
    },
  },
  'github.branch.list': {
    description: 'List branches',
    requiredCapabilities: ['branch.read'],
    riskLevel: 'R0',
    readOnly: true,
    async execute(ctx, args) {
      const r = await ghFetch(ctx.token, 'GET', `/repos/${ctx.owner}/${ctx.repo}/branches?per_page=${args?.perPage || 30}`);
      if (!r.ok) return R.fail(`HTTP ${r.status}: ${r.body?.message}`);
      return R.success((r.body || []).map((b: any) => b.name), true);
    },
  },
  'github.commit.read': {
    description: 'Read commit info',
    requiredCapabilities: ['commit.read'],
    riskLevel: 'R0',
    readOnly: true,
    async execute(ctx, args) {
      if (!args?.sha) return R.fail('sha is required');
      const r = await ghFetch(ctx.token, 'GET', `/repos/${ctx.owner}/${ctx.repo}/commits/${args.sha}`);
      if (!r.ok) return R.fail(`HTTP ${r.status}: ${r.body?.message}`);
      return R.success({ sha: r.body.sha, message: r.body?.commit?.message, author: r.body?.commit?.author }, true);
    },
  },
  'github.actions.read': {
    description: 'Read CI workflow runs',
    requiredCapabilities: ['actions.read'],
    riskLevel: 'R0',
    readOnly: true,
    async execute(ctx, args) {
      const r = await ghFetch(ctx.token, 'GET', `/repos/${ctx.owner}/${ctx.repo}/actions/runs?per_page=${args?.perPage || 20}`);
      if (!r.ok) return R.fail(`HTTP ${r.status}: ${r.body?.message}`);
      return R.success((r.body?.workflow_runs || []).map((w: any) => ({ id: w.id, name: w.name, status: w.status, conclusion: w.conclusion })), true);
    },
  },
};

// ================================================================
// Tool Executor — connection → credential → tool → API → verify
// ================================================================

export async function executeGitHubTool(params: {
  connectionId: string;
  userId: string;
  toolId: string;
  args?: any;
}): Promise<ConnectorResult> {
  const { connectionId, userId, toolId, args } = params;
  const tool = GITHUB_TOOLS[toolId];
  if (!tool) return R.fail(`Unknown tool: ${toolId}`);

  const conn = await prisma.connection.findFirst({ where: { id: connectionId, userId } });
  if (!conn) return R.fail('Connection not found');
  if (!conn.credentialRef) return R.fail('No credential attached', { credentialMissing: true });

  const token = await getSecret(conn.credentialRef, userId);
  if (!token) {
    await prisma.connection.update({ where: { id: conn.id }, data: { status: 'reauth_required' } });
    return R.fail('Credential expired or revoked', { credentialMissing: true });
  }

  if (!conn.owner || !conn.repo) {
    return R.fail('Connection has no repository bound. Set owner/repo first.');
  }

  try {
    return await tool.execute({ token, owner: conn.owner!, repo: conn.repo! }, args);
  } catch (err: any) {
    if (err instanceof GitHubAuthError) {
      await prisma.connection.update({
        where: { id: conn.id },
        data: { status: err.kind === 'revoked' ? 'revoked' : 'expired' },
      });
      return R.fail(`GitHub auth ${err.kind}`, { authError: err.kind });
    }
    return R.fail(err.message);
  }
}
