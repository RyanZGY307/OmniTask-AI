// ================================================================
// Universal Connect Runtime v2 — Plugin Connector (P0-13)
// ================================================================
//
// Plugins are sandboxed third-party code. This connector:
// - Validates plugin manifest
// - Checks plugin is installed and authorized
// - Executes plugin in isolated context
// - Returns NOT_IMPLEMENTED until plugin runtime is built
//
// WARNING: Never return fake success. Return NOT_IMPLEMENTED/FAILED explicitly.
// ================================================================

import { BaseConnector, ConnectorContext, ConnectorResult, HealthResult } from './base';
import { R, healthy, degraded, unhealthy, healthUnknown } from '../contract';
import { prisma } from '../../services/db';

export class PluginConnector extends BaseConnector {
  readonly type = 'plugin' as const;
  readonly name = 'Plugin Connector';

  readonly supportedCapabilities = [
    { capabilityId: 'plugin.execute', toolIds: ['plugin.invoke'], connectorType: 'plugin', authMethod: 'api_key', riskLevel: 'R2', readOnly: false, regions: ['global'] },
    { capabilityId: 'plugin.health', toolIds: ['plugin.health'], connectorType: 'plugin', authMethod: 'api_key', riskLevel: 'R0', readOnly: true, regions: ['global'] },
  ] as any[];

  readonly requiredAuthMethod = 'api_key';
  readonly defaultRiskLevel = 'R2' as const;

  async authenticate(ctx: ConnectorContext, input: Record<string, any>): Promise<{ credentialId: string; accountId?: string; accountName?: string; sessionToken?: string }> {
    const { userId, connectionId } = ctx;
    const conn = await prisma.connection.findUnique({ where: { id: connectionId }, select: { providerId: true } });
    const providerId = conn?.providerId || '';
    const { storeCredential } = await import('../vault');
    const credId = await storeCredential(userId, providerId, 'plugin', JSON.stringify(input.config || {}), {
      pluginId: input.pluginId,
      version: input.version,
    });
    return { credentialId: credId, accountName: `Plugin: ${input.pluginId}` };
  }

  async execute(ctx: ConnectorContext, toolId: string, args: Record<string, any>): Promise<ConnectorResult> {
    const conn = await prisma.connection.findFirst({ where: { id: ctx.connectionId, userId: ctx.userId } });
    if (!conn) return R.fail('Connection not found');

    // P0-13: Validate plugin is installed and authorized
    const pluginInstance = await prisma.pluginInstance.findFirst({
      where: { userId: ctx.userId, status: { in: ['installed', 'authorized', 'connected'] } },
      select: { status: true, config: true, manifestId: true },
    });

    if (!pluginInstance) {
      return R.fail('Plugin not installed or not authorized');
    }

    // P0-13: Check if plugin supports this tool
    const manifest = (pluginInstance.config as any) || {};
    const supportedTools = (pluginInstance.config as any)?.tools || [];
    if (!supportedTools.includes(toolId)) {
      return R.fail(`Plugin does not support tool: ${toolId}`);
    }

    // P0-13: Validate sandbox policy
    const sandboxPolicy = (pluginInstance.config as any)?.sandboxPolicy;
    if (sandboxPolicy?.restrictedTools?.includes(toolId)) {
      return R.fail('Tool restricted by sandbox policy');
    }

    // P0-13: Plugin execution runtime is not yet implemented
    // Return NOT_IMPLEMENTED instead of fake success
    // P0-0: 保持 NOT_IMPLEMENTED 为独立状态 —— 不得用成功响应替代。
    return R.notImplemented(
      `Plugin runtime not implemented for: ${toolId}. Plugin ${manifest?.name || 'unknown'} requires explicit execution engine.`,
      { pluginStatus: pluginInstance.status, required: 'plugin_execution_engine' },
    );
  }

  async refresh(_ctx: ConnectorContext): Promise<void> {
    // Plugin refresh: re-validate manifest and permissions
  }

  async revoke(ctx: ConnectorContext): Promise<void> {
    const { revokeCredential } = await import('../vault');
    const conn = await prisma.connection.findUnique({ where: { id: ctx.connectionId } });
    if (conn?.credentialRef) await revokeCredential(conn.credentialRef, ctx.userId);
    await prisma.connection.update({ where: { id: ctx.connectionId }, data: { status: 'revoked' } });
  }

  async healthCheck(ctx: ConnectorContext): Promise<HealthResult> {
    const conn = await prisma.connection.findFirst({ where: { id: ctx.connectionId, userId: ctx.userId } });
    if (!conn) return unhealthy('Connection not found');

    // Check plugin instance health
    const plugin = await prisma.pluginInstance.findFirst({
      where: { userId: ctx.userId },
      select: { healthStatus: true, lastHealthCheck: true },
    });

    if (!plugin) return unhealthy('No plugin instance found');
    if (plugin.healthStatus === 'unhealthy') return unhealthy('Plugin unhealthy');
    if (plugin.healthStatus === 'degraded') {
      // 旧版：ok:true + 写死 latencyMs:100 + error:'Degraded'。降级不应报健康，
      // 更不应伪造延迟。这里如实报 degraded；没有真实测量就不填 latencyMs。
      return degraded(undefined, 'Plugin reported degraded status');
    }

    // 旧版：返回 `latencyMs: 10` 与 'Plugin health check passed (simulated)'
    // —— 从未联系过插件进程，是伪造遥测。插件执行引擎不存在（execute() 已诚实
    // 返回 not_implemented），因此健康状态同样必须如实：无法探测即 unknown。
    return healthUnknown('Plugin execution engine is not implemented; no live process to probe');
  }
}

export const pluginConnector = new PluginConnector();
