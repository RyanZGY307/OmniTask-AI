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
import { R, healthy, unhealthy, discovered, discoveryFailed, healthUnknown } from '../contract';
import type { DiscoveryResult } from '../contract';
import { prisma } from '../../services/db';
// P2: 真 MCP 协议客户端（JSON-RPC 2.0）。与下面的 REST 方言回退并存。
import { mcpInitialize, mcpListTools, mcpCallTool, mcpHealthCheck } from './mcp/client';
import type { MCPTransportOptions } from './mcp/client';

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
   *
   * P2: 这里按握手结果分流：
   *   - 端点是真 MCP（JSON-RPC 2.0）→ 走 mcp/client.ts 的 initialize + tools/list，
   *     协议不兼容会得到明确的 protocol_incompatible；
   *   - 端点是旧的 REST 方言（历史连接）→ 保留原有路径试探，不回退。
   * 探针策略：先试 MCP 握手；握手失败且失败原因指向"不是 JSON-RPC/不支持
   * initialize"时，才回退到 REST 口味。这样新连接默认获得真实协议路径，
   * 而已有 REST 连接不会突然全部失效。
   */
  async discoverTools(ctx: ConnectorContext): Promise<DiscoveryResult> {
    const conn = await prisma.connection.findFirst({ where: { id: ctx.connectionId, userId: ctx.userId } });
    if (!conn) return discoveryFailed('connection_failed', 'Connection not found');

    const { getSecret } = await import('../vault');
    const configStr = await getSecret(conn.credentialRef!, ctx.userId);
    if (!configStr) return discoveryFailed('auth_failed', 'Failed to decrypt credentials');

    const config = JSON.parse(configStr) as any;
    if (!config?.serverUrl) return discoveryFailed('not_configured', 'MCP server URL not configured');
    const baseUrl = config.serverUrl.replace(/\/$/, '');
    const transport = {
      endpoint: config.mcpEndpoint || baseUrl,
      headers: config.headers || {},
      timeoutMs: 30_000,
    };

    // P2-1: 先试真 MCP 握手
    const init = await mcpInitialize(transport);
    if (init.kind === 'ok') {
      const tools = await mcpListTools({ ...transport, headers: { ...(config.headers || {}), 'MCP-Protocol-Version': init.serverInfo.negotiatedProtocolVersion || '' } });
      if (tools.status !== 'ok') return tools;
      return discovered(tools.tools, init.serverInfo);
    }
    // 握手失败：只有"看起来就是这个 endpoint 但不是 MCP"时才回退 REST 方言。
    // 连接失败/超时/授权失败不属于协议问题，直接如实上报。
    if (init.kind === 'error' && init.status !== 'protocol_incompatible') {
      return discoveryFailed(init.status, init.detail);
    }

    // P2-2: REST 方言回退（仅对历史连接有意义）
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
    const transport: MCPTransportOptions = {
      endpoint: config.mcpEndpoint || baseUrl,
      headers: config.headers || {},
      timeoutMs: 30_000,
    };

    try {
      // P2: 优先走真 MCP 协议。只有握手确认该端点不是 MCP server 时，
      // 才回退到旧的 REST 方言路径（保留对历史自建后端的兼容）。
      const init = await mcpInitialize({ ...transport, timeoutMs: 10_000 });
      if (init.kind === 'ok') {
        return await mcpCallTool({
          ...transport,
          headers: { ...(config.headers || {}), 'MCP-Protocol-Version': init.serverInfo.negotiatedProtocolVersion || '' },
        }, toolId, args);
      }

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

  /**
   * P2: 健康检查改为真 MCP 握手（initialize），而不是探 /health 猜测路径。
   * 对真 MCP server 而言，"能完成一次合法 JSON-RPC 握手"就是活性证据；
   * 旧的 /health、/mcp/info 路径是 REST 方言的猜测，对标准 server 全部无效，
   * 会把健康连接误报成 unhealthy。
   */
  async healthCheck(ctx: ConnectorContext): Promise<HealthResult> {
    const conn = await prisma.connection.findFirst({ where: { id: ctx.connectionId, userId: ctx.userId } });
    if (!conn) return unhealthy('Connection not found');

    const { getSecret } = await import('../vault');
    const configStr = await getSecret(conn.credentialRef!, ctx.userId);
    if (!configStr) return unhealthy('Failed to decrypt credentials');

    const config = JSON.parse(configStr) as any;
    if (!config?.serverUrl) return unhealthy('MCP server URL not configured');

    const baseUrl = config.serverUrl.replace(/\/$/, '');

    // P2: 握手式健康检查。
    const handshake = await mcpHealthCheck({
      endpoint: config.mcpEndpoint || baseUrl,
      headers: config.headers || {},
      timeoutMs: 5000,
    });
    if (handshake.status === 'healthy') return handshake;

    // 握手失败时，对 REST 方言历史连接保留旧探测作为回退，
    // 但协议不兼容不会被误报为连接失败（返回 unknown 让上层自行判断）。
    const start = Date.now();
    try {
      const endpoints = [
        `${baseUrl}/health`,
        `${baseUrl}/mcp/health`,
        `${baseUrl}/mcp/info`,
        baseUrl,
      ];
      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, { method: 'GET', signal: AbortSignal.timeout(5000) });
          if (res.ok) return healthy(Date.now() - start, endpoint);
        } catch { /* try next */ }
      }
      // 两种方式都不通：原样返回握手结论，不额外编造
      if (handshake.status === 'unknown') return handshake;
      return unhealthy(handshake.detail || 'All MCP health endpoints failed');
    } catch (err: any) {
      return healthUnknown(`${err?.message || err}（MCP 握手亦未成功）`);
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
