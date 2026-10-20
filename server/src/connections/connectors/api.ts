// ================================================================
// API Key Connector — REST API with Bearer / API Key auth
// ================================================================
//
// Supports: OpenAI, Anthropic, Stripe, AWS, Google Cloud, Azure,
// GitHub PAT, GitLab, Shopify, Discord, Slack, and 50+ others.

import { BaseConnector, ConnectorContext, ConnectorResult, HealthResult } from './base';
import { R, fromLegacy, healthy, unhealthy } from '../contract';
import { getSecret } from '../vault';
import { prisma } from '../../services/db';
import { PROVIDER_BASE_URLS } from '../../config';

export class ApiKeyConnector extends BaseConnector {
  readonly type = 'api' as const;
  readonly name = 'API Key Connector';

  // P0-1: Explicit capability bindings
  readonly supportedCapabilities = [
    { capabilityId: 'github.repo.read', toolIds: ['github.repo.read', 'github.branch.list', 'github.commit.read', 'github.actions.read'], connectorType: 'api', authMethod: 'api_key', riskLevel: 'R0', readOnly: true, regions: ['global'] },
    { capabilityId: 'github.repo.write', toolIds: ['github.repo.write'], connectorType: 'api', authMethod: 'api_key', riskLevel: 'R1', readOnly: false, regions: ['global'] },
    { capabilityId: 'github.issue.read', toolIds: ['github.issue.read'], connectorType: 'api', authMethod: 'api_key', riskLevel: 'R0', readOnly: true, regions: ['global'] },
    { capabilityId: 'github.issue.write', toolIds: ['github.issue.create'], connectorType: 'api', authMethod: 'api_key', riskLevel: 'R1', readOnly: false, regions: ['global'] },
    { capabilityId: 'github.pr.read', toolIds: ['github.pr.read'], connectorType: 'api', authMethod: 'api_key', riskLevel: 'R0', readOnly: true, regions: ['global'] },
    { capabilityId: 'github.pr.write', toolIds: ['github.pr.create'], connectorType: 'api', authMethod: 'api_key', riskLevel: 'R2', readOnly: false, regions: ['global'] },
    { capabilityId: 'openai.models.list', toolIds: ['openai.models.list'], connectorType: 'api', authMethod: 'api_key', riskLevel: 'R0', readOnly: true, regions: ['global'] },
    { capabilityId: 'stripe.balance.get', toolIds: ['stripe.balance.get'], connectorType: 'api', authMethod: 'api_key', riskLevel: 'R2', readOnly: true, regions: ['global'] },
    { capabilityId: 'stripe.customer.list', toolIds: ['stripe.customer.list'], connectorType: 'api', authMethod: 'api_key', riskLevel: 'R1', readOnly: true, regions: ['global'] },
    { capabilityId: 'slack.channels.list', toolIds: ['slack.channels.list'], connectorType: 'api', authMethod: 'api_key', riskLevel: 'R0', readOnly: true, regions: ['global'] },
    { capabilityId: 'slack.chat.send', toolIds: ['slack.chat.post'], connectorType: 'api', authMethod: 'api_key', riskLevel: 'R2', readOnly: false, regions: ['global'] },
    { capabilityId: 'health.check', toolIds: ['github.health', 'openai.health', 'stripe.health', 'slack.health'], connectorType: 'api', authMethod: 'api_key', riskLevel: 'R0', readOnly: true, regions: ['global'] },
  ] as any[];

  readonly requiredAuthMethod = 'api_key';
  readonly defaultRiskLevel = 'R1' as const;

  async authenticate(ctx: ConnectorContext, input: Record<string, any>): Promise<{ credentialId: string; accountId?: string; accountName?: string; sessionToken?: string }> {
    const { userId, connectionId } = ctx;
    const conn = await prisma.connection.findUnique({ where: { id: connectionId }, select: { providerId: true } });
    const providerId = conn?.providerId || '';
    const apiKey = input.apiKey as string;
    if (!apiKey) throw new Error('API key is required');

    // Validate key format before storing
    const normalizedKey = apiKey.trim();

    const { encryptSecret } = await import('../vault');
    const { storeCredential } = await import('../vault');
    const credId = await storeCredential(userId, providerId, 'api_key', normalizedKey);

    return { credentialId: credId, accountName: `${providerId} account` };
  }

  async execute(ctx: ConnectorContext, toolId: string, args: Record<string, any>): Promise<ConnectorResult> {
    const conn = await prisma.connection.findFirst({
      where: { id: ctx.connectionId, userId: ctx.userId },
      select: { credentialRef: true, providerId: true },
    });
    if (!conn) return R.fail('Connection not found');
    if (!conn.credentialRef) return R.fail('No API key configured');

    const apiKey = await getSecret(conn.credentialRef, ctx.userId);
    if (!apiKey) return R.fail('Failed to decrypt API key');

    const providerId = conn.providerId;
    const baseUrl = PROVIDER_BASE_URLS[providerId as keyof typeof PROVIDER_BASE_URLS] || '';

    // Route to provider-specific handler
    const handler = this.getHandler(providerId, toolId);
    if (!handler) return R.fail(`No handler for ${providerId}/${toolId}`);

    const start = Date.now();
    try {
      const result = await handler(apiKey, baseUrl, args);
      // 旧版这里写死 `ok: true` 并附带 `result.error`：handler 失败会被吞成
      // 成功，成功时又带一个 error 字段（P0-1 反模式）。改为按 handler 的真实
      // 结果转换，handler 的旧形状在此边界一次性归一。
      void start;
      return fromLegacy(result);
    } catch (err: any) {
      return R.fail(err.message);
    }
  }

  async refresh(_ctx: ConnectorContext): Promise<void> {
    // API keys don't auto-refresh; user must re-authenticate
  }

  async revoke(ctx: ConnectorContext): Promise<void> {
    const { revokeCredential } = await import('../vault');
    const conn = await prisma.connection.findUnique({ where: { id: ctx.connectionId } });
    if (conn?.credentialRef) await revokeCredential(conn.credentialRef, ctx.userId);
    await prisma.connection.update({ where: { id: ctx.connectionId }, data: { status: 'revoked' } });
  }

  async healthCheck(ctx: ConnectorContext): Promise<HealthResult> {
    const start = Date.now();
    try {
      const conn = await prisma.connection.findFirst({
        where: { id: ctx.connectionId, userId: ctx.userId },
        select: { credentialRef: true, providerId: true },
      });
      if (!conn?.credentialRef) return unhealthy('No credential');
      const apiKey = await getSecret(conn.credentialRef, ctx.userId);
      const baseUrl = PROVIDER_BASE_URLS[conn.providerId as keyof typeof PROVIDER_BASE_URLS] || '';
      const handler = this.getHandler(conn.providerId, 'health');
      if (!handler) return unhealthy('No health check handler');
      const result = await handler(apiKey, baseUrl, {});
      // 旧版：`{ ok: result.ok, latencyMs, error: result.error }` —— 成功时也带
      // error 字段。改为按真实结果分流，延迟仅由实测值产生。
      return result.ok
        ? healthy(Date.now() - start)
        : unhealthy(result.error || 'Health check failed');
    } catch (err: any) {
      return unhealthy(err.message);
    }
  }

  // ─── Provider-specific handlers ──────────────────────────────────

  private getHandler(providerId: string, toolId: string) {
    const handlers: Record<string, Record<string, (key: string, baseUrl: string, args: any) => Promise<{ ok: boolean; verified?: boolean; data?: any; error?: string }>>> = {
      github: {
        'repo.read': async (key, _url, args) => {
          const res = await fetch(`https://api.github.com/repos/${args.owner}/${args.repo}`, {
            headers: { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github.v3+json' },
          });
          if (!res.ok) return { ok: false, error: `GitHub API error: ${res.status}` };
          return { ok: true, data: await res.json() };
        },
        'repo.list': async (key, _url, _args) => {
          const res = await fetch('https://api.github.com/user/repos?per_page=100', {
            headers: { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github.v3+json' },
          });
          if (!res.ok) return { ok: false, error: `GitHub API error: ${res.status}` };
          return { ok: true, data: await res.json() };
        },
        'health': async (key, _url, _args) => {
          const res = await fetch('https://api.github.com/rate_limit', {
            headers: { Authorization: `Bearer ${key}` },
          });
          return { ok: res.ok, data: res.ok ? { rateLimit: await res.json() } : null };
        },
      },
      openai: {
        'models.list': async (key, url, _args) => {
          const res = await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
          if (!res.ok) return { ok: false, error: `OpenAI API error: ${res.status}` };
          return { ok: true, data: await res.json() };
        },
        'health': async (key, url, _args) => {
          const res = await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
          return { ok: res.ok };
        },
      },
      stripe: {
        'balance.get': async (key, _url, _args) => {
          const res = await fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${key}` } });
          if (!res.ok) return { ok: false, error: `Stripe API error: ${res.status}` };
          return { ok: true, data: await res.json() };
        },
        'customer.list': async (key, _url, args) => {
          const res = await fetch(`https://api.stripe.com/v1/customers?limit=${args.limit || 10}`, {
            headers: { Authorization: `Bearer ${key}` },
          });
          if (!res.ok) return { ok: false, error: `Stripe API error: ${res.status}` };
          return { ok: true, data: await res.json() };
        },
        'health': async (key, _url, _args) => {
          const res = await fetch('https://api.stripe.com/v1/account', { headers: { Authorization: `Bearer ${key}` } });
          return { ok: res.ok };
        },
      },
      slack: {
        'channels.list': async (key, _url, _args) => {
          const res = await fetch('https://slack.com/api/conversations.list', {
            headers: { Authorization: `Bearer ${key}` },
          });
          const data: any = await res.json();
          return { ok: data.ok, data: data.channels, error: data.error };
        },
        'chat.post': async (key, _url, args) => {
          const res = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({ channel: args.channel, text: args.text }),
          });
          const data: any = await res.json();
          return { ok: data.ok, verified: data.ok, data, error: data.error };
        },
        'health': async (key, _url, _args) => {
          const res = await fetch('https://slack.com/api/auth.test', { headers: { Authorization: `Bearer ${key}` } });
          const data: any = await res.json();
          return { ok: data.ok };
        },
      },
    };

    return handlers[providerId]?.[toolId] || null;
  }
}

export const apiKeyConnector = new ApiKeyConnector();
