// ================================================================
// Universal Connect Runtime v2 — Provider Health Monitor
// Tracks health per provider/connector, enables failover
// ================================================================

import { prisma } from '../../services/db';
import type { ProviderHealthSummary } from '../types';
import { getProviderById } from '../registry/global';

export interface HealthCheckInput {
  providerId: string;
  connectorType: string;
  userId?: string; // optional: user-specific health
}

export interface HealthCheckResult {
  providerId: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  availability: number;
  latencyMs: number;
  errorRate: number;
  errorMessage?: string;
  connectorType: string;
}

// ─── Run Health Check ───────────────────────────────────────────────

export async function checkProviderHealth(input: HealthCheckInput): Promise<HealthCheckResult> {
  const start = Date.now();
  let ok = false;
  let errorMessage: string | undefined;
  let latencyMs = 0;

  try {
    // Try provider-specific health endpoint
    const manifest = getProviderById(input.providerId);
    if (manifest?.healthCheckUrl) {
      const res = await fetch(manifest.healthCheckUrl, { signal: AbortSignal.timeout(10000) });
      ok = res.ok;
      latencyMs = Date.now() - start;
    } else {
      // Fallback: HTTP HEAD to website
      const res = await fetch(`https://${input.providerId}.com`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      ok = res.ok;
      latencyMs = Date.now() - start;
    }
  } catch (err: any) {
    errorMessage = err.message;
    latencyMs = Date.now() - start;
  }

  const status = !ok ? 'unhealthy' : latencyMs > 2000 ? 'degraded' : 'healthy';

  // Store health log
  await prisma.providerHealth.create({
    data: {
      platformManifestId: input.providerId, // uses providerId as FK for simplicity
      connectorType: input.connectorType,
      status,
      availability: ok ? 1.0 : 0.0,
      latencyMs,
      errorRate: ok ? 0.0 : 1.0,
      errorMessage,
    },
  });

  return {
    providerId: input.providerId,
    status: status as any,
    availability: ok ? 1.0 : 0.0,
    latencyMs,
    errorRate: ok ? 0.0 : 1.0,
    errorMessage,
    connectorType: input.connectorType,
  };
}

// ─── Get Health Summary ─────────────────────────────────────────────

export async function getHealthSummary(providerId: string): Promise<ProviderHealthSummary> {
  const manifest = getProviderById(providerId);
  const latest = await prisma.providerHealth.findFirst({
    where: { platformManifestId: providerId },
    orderBy: { checkedAt: 'desc' },
  });

  const recent = await prisma.providerHealth.findMany({
    where: { platformManifestId: providerId, checkedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    orderBy: { checkedAt: 'desc' },
    take: 100,
  });

  const healthy = recent.filter((h) => h.status === 'healthy').length;
  const total = recent.length || 1;

  return {
    providerId,
    displayName: manifest?.displayName || providerId,
    overallStatus: latest?.status as any || 'unknown',
    lastCheckAt: latest?.checkedAt,
    errorRate: recent.length > 0 ? 1 - healthy / total : 0,
    connectivity: { [latest?.connectorType || 'api']: (latest?.status || 'unknown') as any },
  };
}

// ─── Failover Routing ───────────────────────────────────────────────
// When a provider is unhealthy, route to alternative connectors.

export interface FailoverRoute {
  providerId: string;
  originalConnector: string;
  alternativeConnector: string;
  reason: string;
}

export function getFailoverRoute(providerId: string, failedConnector: string): FailoverRoute | null {
  const manifest = getProviderById(providerId);
  if (!manifest) return null;

  const alternatives: Record<string, string[]> = {
    api: ['oauth', 'browser', 'generic_web'],
    oauth: ['api', 'browser', 'generic_web'],
    browser: ['api', 'oauth', 'generic_web'],
    generic_web: ['browser', 'api', 'oauth'],
  };

  const opts = alternatives[failedConnector] || [];
  for (const alt of opts) {
    const supported = {
      api: manifest.apiSupported,
      oauth: manifest.oauthSupported,
      browser: manifest.browserSupported,
      generic_web: manifest.genericWebSupported,
    }[alt];
    if (supported) {
      return { providerId, originalConnector: failedConnector, alternativeConnector: alt, reason: `Failover: ${failedConnector} unavailable` };
    }
  }
  return null;
}
