// ================================================================
// Universal Connect Runtime v2 — Generic Web Connector
// For websites without API/OAuth — uses browser automation as fallback
// ================================================================

import { BaseConnector, ConnectorContext, ConnectorResult } from './base';

export class GenericWebConnector extends BaseConnector {
  readonly type = 'generic_web' as const;
  readonly name = 'Generic Web Connector';

  readonly supportedCapabilities = [] as any[];
  readonly requiredAuthMethod = 'browser';
  readonly defaultRiskLevel = 'R1' as const;

  async authenticate(ctx: ConnectorContext, input: Record<string, any>): Promise<{ credentialId: string; accountId?: string; accountName?: string; sessionToken?: string }> {
    // Delegates to browser connector for web-based auth
    const { browserConnector } = await import('./browser');
    return browserConnector.authenticate(ctx, input);
  }

  async execute(ctx: ConnectorContext, toolId: string, args: Record<string, any>): Promise<ConnectorResult> {
    // Delegate to browser connector
    const { browserConnector } = await import('./browser');
    return browserConnector.execute(ctx, toolId, args);
  }

  async refresh(ctx: ConnectorContext): Promise<void> {
    const { browserConnector } = await import('./browser');
    await browserConnector.refresh(ctx);
  }

  async revoke(ctx: ConnectorContext): Promise<void> {
    const { browserConnector } = await import('./browser');
    await browserConnector.revoke(ctx);
  }

  async healthCheck(_ctx: ConnectorContext): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    return { ok: true, latencyMs: 1 };
  }
}

export const genericWebConnector = new GenericWebConnector();
