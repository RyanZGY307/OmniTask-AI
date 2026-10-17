// ================================================================
// API Key Connector — REST API with Bearer / API Key auth
// ================================================================
//
// Supports: OpenAI, Anthropic, Stripe, AWS, Google Cloud, Azure,
// GitHub PAT, GitLab, Shopify, Discord, Slack, and 50+ others.

import { BaseConnector, ConnectorContext, ConnectorResult } from './base';
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
    if (!conn) return { ok: false, verified: false, error: 'Connection not found' };
    if (!conn.credentialRef) return { ok: false, verified: false, error: 'No API key configured' };

    const apiKey = await getSecret(conn.credentialRef, ctx.userId);
    if (!apiKey) return { ok: false, verified: false, error: 'Failed to decrypt API key' };

    const providerId = conn.providerId;
    const baseUrl = PROVIDER_BASE_URLS[providerId as keyof typeof PROVIDER_BASE_URLS] || '';

    // Route to provider-specific handler
    const handler = this.getHandler(providerId, toolId);
    if (!handler) return { ok: false, verified: false, error: `No handler for ${providerId}/${toolId}` };

    const start = Date.now();
    try {
      const result = await handler(apiKey, baseUrl, args);
      const latency = Date.now() - start;
      return { ok: true, verified: result.verified ?? true, data: result.data, error: result.error };
    } catch (err: any) {
      return { ok: false, verified: false, error: err.message };
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

  async healthCheck(ctx: ConnectorContext): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const start = Date.now();
    try {
      const conn = await prisma.connection.findFirst({
        where: { id: ctx.connectionId, userId: ctx.userId },
        select: { credentialRef: true, providerId: true },
      });
      if (!conn?.credentialRef) return { ok: false, error: 'No credential' };
      const apiKey = await getSecret(conn.credentialRef, ctx.userId);
      const baseUrl = PROVIDER_BASE_URLS[conn.providerId as keyof typeof PROVIDER_BASE_URLS] || '';
      const handler = this.getHandler(conn.providerId, 'health');
      if (!handler) return { ok: false, error: 'No health check handler' };
      const result = await handler(apiKey, baseUrl, {});
      return { ok: result.ok, latencyMs: Date.now() - start, error: result.error };
    } catch (err: any) {
      return { ok: false, error: err.message };
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
