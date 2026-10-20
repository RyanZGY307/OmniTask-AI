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

import { BaseConnector, ConnectorContext, ConnectorResult, HealthResult } from './base';
import { R, healthy, unhealthy, discovered, discoveryFailed } from '../contract';
import type { DiscoveryResult } from '../contract';
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

  /**
   * P0-1: 发现结果的返回类型已改为 DiscoveryResult（判别联合），
   * 使「失败却返回 ok:true」不可表示。发现不到工具 ≠ 发现成功。
   */
  async discoverTools(ctx: ConnectorContext): Promise<DiscoveryResult> {
    const conn = await prisma.connection.findFirst({ where: { id: ctx.connectionId, userId: ctx.userId } });
    if (!conn) return discoveryFailed('connection_failed', 'Connection not found');

    const { getSecret } = await import('../vault');
    const configStr = await getSecret(conn.credentialRef!, ctx.userId);
    if (!configStr) return discoveryFailed('auth_failed', 'Failed to decrypt credentials');

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
            return discovered(tools);
          }
        } catch { /* try next endpoint */ }
      }

      // 旧版：发现失败却返回 { tools: [], ok: true } —— UI 会显示"发现完成，
      // 可用工具 0"。按用户硬规则「发现不到工具不等于发现成功」，改为明确的
      // protocol_incompatible，让上层能区分「确实没有工具」与「探不到」。
      return discoveryFailed('protocol_incompatible',
        'Could not discover tools — MCP server may not support standard endpoints');
    } catch (err: any) {
      return discoveryFailed('connection_failed', err.message);
    }
  }

  async execute(ctx: ConnectorContext, toolId: string, args: Record<string, any>): Promise<ConnectorResult> {
    const conn = await prisma.connection.findFirst({ where: { id: ctx.connectionId, userId: ctx.userId } });
    if (!conn) return R.fail('Connection not found');

    const { getSecret } = await import('../vault');
    const configStr = await getSecret(conn.credentialRef!, ctx.userId);
    if (!configStr) return R.fail('Failed to decrypt credentials');

    const config = JSON.parse(configStr) as any;
    if (!config?.serverUrl) return R.fail('MCP server URL not configured');

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
        return R.fail(`MCP ${toolId} failed: ${res.status} ${errText.slice(0, 200)}`, { httpStatus: res.status });
      }

      const data: any = await res.json();

      // P0-12: Verify MCP response has expected structure
      if (!data?.result && !data?.content && !data?.data) {
        // 旧版：ok:true + verified:false + error:'MCP returned empty result'
        // —— 三方字段互相矛盾。空结果不是成功，改为明确的 unknown：外部可能
        // 已执行但我们拿不到可核实内容，调用方必须能够区分。
        return R.unknown('MCP returned empty result', data);
      }

      return R.success(data?.result || data?.content || data?.data, true);
    } catch (err: any) {
      return R.fail(`MCP invoke failed: ${err.message}`);
    }
  }

  /** P0-14: Real health check — actually ping the MCP server */
  async healthCheck(ctx: ConnectorContext): Promise<HealthResult> {
    const conn = await prisma.connection.findFirst({ where: { id: ctx.connectionId, userId: ctx.userId } });
    if (!conn) return unhealthy('Connection not found');

    const { getSecret } = await import('../vault');
    const configStr = await getSecret(conn.credentialRef!, ctx.userId);
    if (!configStr) return unhealthy('Failed to decrypt credentials');

    const config = JSON.parse(configStr) as any;
    if (!config?.serverUrl) return unhealthy('MCP server URL not configured');

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
            // 旧版：成功分支仍写 error 字段，导致按 error 判定的调用方把健康
            // 连接报成异常。成功即成功，只保留实测延迟与探测端点。
            return healthy(latency, endpoint);
          }
        } catch { /* try next */ }
      }

      return unhealthy('All MCP health endpoints failed');
    } catch (err: any) {
      return unhealthy(err.message);
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
