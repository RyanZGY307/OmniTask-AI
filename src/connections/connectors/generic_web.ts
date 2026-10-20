// ================================================================
// Universal Connect Runtime v2 — Generic Web Connector
// For websites without API/OAuth — uses browser automation as fallback
// ================================================================

import { BaseConnector, ConnectorContext, ConnectorResult, HealthResult } from './base';
import { healthUnknown } from '../contract';

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

  async healthCheck(ctx: ConnectorContext): Promise<HealthResult> {
    // 旧版这里直接返回 `{ ok: true, latencyMs: 1 }`：不发任何请求、写死延迟，
    // 属于伪造遥测（P0-1）。generic_web 本身没有独立传输，健康状态完全由
    // 浏览器连接器决定，因此如实委派；无法委派时返回 unknown 而非假成功。
    try {
      const { browserConnector } = await import('./browser');
      return await browserConnector.healthCheck(ctx);
    } catch (err: any) {
      return healthUnknown(`Generic web health check could not delegate: ${err?.message || err}`);
    }
  }
}

export const genericWebConnector = new GenericWebConnector();
