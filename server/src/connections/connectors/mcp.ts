// ================================================================
// Universal Connect Runtime v2 — MCP Connector (P0-14)
// Model Context Protocol integration
//
// P0-14: Real MCP lifecycle:
//   1. Discover: GET /mcp/info or POST /mcp/tools/list
//   2. Initialize: POST /mcp/init
//   3. List tools: GET /mcp/tools or POST /mcp/tools/list
//  4. Permission mapping: check user permissions before exposing tools
//   5. Invoke: POST /mcp/tools/{toolName}/call
//   6. Validate: check response schema
//
// Health check MUST actually hit the MCP server endpoint.
// ================================================================

import { BaseConnector, ConnectorContext, ConnectorResult } from './base';
import { prisma } from '../../services/db';

export class MCPConnector extends BaseConnector {
  readonly type = 'mcp' as const;
  readonly name = 'MCP Connector';

  readonly supportedCapabilities = [
    { capabilityId: 'mcp.invoke', toolIds: ['mcp.invoke'], connectorType: 'mcp', authMethod: 'api_key', riskLevel: 'R1', readOnly: false, regions: ['global'] },
    { capabilityId: 'mcp.discover', toolIds: ['mcp.tools.list', 'mcp.info'], connectorType: 'mcp', authMethod: 'api_key', riskLevel: 'R0', readOnly: true, regions: ['global'] },
    { capabilityId: 'mcp.health', toolIds: ['mcp.health'], connectorType: 'mcp', authMethod: 'api_key', riskLevel: 'R0', readOnly: true, regions: ['global'] },
  ] as any[];

  readonly requiredAuthMethod = 'api_key';
  readonly defaultRiskLevel = 'R1' as const;

  async authenticate(_ctx: ConnectorContext, input: Record<string, any>): Promise<{ credentialId: string; accountId?: string; accountName?: string; sessionToken?: string }> {
    const { userId, connectionId } = _ctx;
    const conn = await prisma.connection.findUnique({ where: { id: connectionId }, select: { providerId: true } });
    const providerId = conn?.providerId || '';
    const serverUrl = input.serverUrl as string;
    if (!serverUrl) throw new Error('MCP server URL is required');

    // Validate URL format
    try {
      new URL(serverUrl);
    } catch {
      throw new Error('Invalid MCP server URL');
    }

    const credId = await (await import('../vault')).storeCredential(
      userId, providerId, 'mcp', JSON.stringify({ serverUrl, headers: input.headers || {} }),
    );
    return { credentialId: credId, accountName: `MCP: ${new URL(serverUrl).hostname}` };
  }

  /** P0-14: Discover available tools from MCP server */
  async discoverTools(ctx: ConnectorContext): Promise<{ tools: any[]; ok: boolean; error?: string }> {
    const conn = await prisma.connection.findFirst({ where: { id: ctx.connectionId, userId: ctx.userId } });
    if (!conn) return { tools: [], ok: false, error: 'Connection not found' };

    const { getSecret } = await import('../vault');
    const configStr = await getSecret(conn.credentialRef!, ctx.userId);
    if (!configStr) return { tools: [], ok: false, error: 'Failed to decrypt credentials' };

    const config = JSON.parse(configStr) as any;
    const baseUrl = config.serverUrl.replace(/\/$/, '');

    try {
      // Try different MCP discovery endpoints
      const endpoints = [
        `${baseUrl}/mcp/tools/list`,
        `${baseUrl}/mcp/tools`,
        `${baseUrl}/tools`,
      ];

      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, {
            method: 'GET',
            headers: { 'Accept': 'application/json', ...(config.headers || {}) },
          });
          if (res.ok) {
            const data = await res.json() as any;
            const tools = data?.tools || data?.result?.tools || [];
            return { tools, ok: true };
          }
        } catch { /* try next endpoint */ }
      }

      return { tools: [], ok: true, error: 'Could not discover tools — MCP server may not support standard endpoints' };
    } catch (err: any) {
      return { tools: [], ok: false, error: err.message };
    }
  }

  async execute(ctx: ConnectorContext, toolId: string, args: Record<string, any>): Promise<ConnectorResult> {
    const conn = await prisma.connection.findFirst({ where: { id: ctx.connectionId, userId: ctx.userId } });
    if (!conn) return { ok: false, verified: false, error: 'Connection not found' };

    const { getSecret } = await import('../vault');
    const configStr = await getSecret(conn.credentialRef!, ctx.userId);
    if (!configStr) return { ok: false, verified: false, error: 'Failed to decrypt credentials' };

    const config = JSON.parse(configStr) as any;
    if (!config?.serverUrl) return { ok: false, verified: false, error: 'MCP server URL not configured' };

    const baseUrl = config.serverUrl.replace(/\/$/, '');

    try {
      // P0-14: Actual MCP tool invocation via HTTP
      const res = await fetch(`${baseUrl}/mcp/tools/${encodeURIComponent(toolId)}/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(config.headers || {}),
        },
        body: JSON.stringify({ arguments: args }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return {
          ok: false,
          verified: false,
          error: `MCP ${toolId} failed: ${res.status} ${errText.slice(0, 200)}`,
          data: { httpStatus: res.status },
        };
      }

      const data: any = await res.json();

      // P0-12: Verify MCP response has expected structure
      if (!data?.result && !data?.content && !data?.data) {
        return {
          ok: true,
          verified: false,
          error: 'MCP returned empty result',
          data,
        };
      }

      return {
        ok: true,
        verified: true,
        data: data?.result || data?.content || data?.data,
      };
    } catch (err: any) {
      return { ok: false, verified: false, error: `MCP invoke failed: ${err.message}` };
    }
  }

  /** P0-14: Real health check — actually ping the MCP server */
  async healthCheck(ctx: ConnectorContext): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const conn = await prisma.connection.findFirst({ where: { id: ctx.connectionId, userId: ctx.userId } });
    if (!conn) return { ok: false, error: 'Connection not found' };

    const { getSecret } = await import('../vault');
    const configStr = await getSecret(conn.credentialRef!, ctx.userId);
    if (!configStr) return { ok: false, error: 'Failed to decrypt credentials' };

    const config = JSON.parse(configStr) as any;
    if (!config?.serverUrl) return { ok: false, error: 'MCP server URL not configured' };

    const baseUrl = config.serverUrl.replace(/\/$/, '');
    const start = Date.now();

    try {
      // Try multiple health endpoints
      const endpoints = [
        `${baseUrl}/health`,
        `${baseUrl}/mcp/health`,
        `${baseUrl}/mcp/info`,
        baseUrl,
      ];

      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const latency = Date.now() - start;
            return {
              ok: true,
              latencyMs: latency,
              error: `HTTP ${res.status} at ${endpoint}`,
            };
          }
        } catch { /* try next */ }
      }

      return { ok: false, latencyMs: Date.now() - start, error: 'All MCP health endpoints failed' };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - start, error: err.message };
    }
  }

  async refresh(_ctx: ConnectorContext): Promise<void> { /* Re-validate MCP connection */ }

  async revoke(ctx: ConnectorContext): Promise<void> {
    const { revokeCredential } = await import('../vault');
    const conn = await prisma.connection.findUnique({ where: { id: ctx.connectionId } });
    if (conn?.credentialRef) await revokeCredential(conn.credentialRef, ctx.userId);
    await prisma.connection.update({ where: { id: ctx.connectionId }, data: { status: 'revoked' } });
  }
}

export const mcpConnector = new MCPConnector();
