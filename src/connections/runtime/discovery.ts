// ================================================================
// Universal Connect Runtime v2 — Discovery Engine
// Natural-language platform identification
// ================================================================

import { ALL_PROVIDERS, getProviderById } from '../registry/global';
import type { DiscoveryResult } from '../types';

// ─── Keyword → Provider mapping ─────────────────────────────────────
const KEYWORD_INDEX: Record<string, string[]> = {};

for (const provider of ALL_PROVIDERS) {
  const keywords = [
    provider.providerId,
    provider.displayName.toLowerCase(),
    ...(provider.description ? [provider.description.toLowerCase()] : []),
    ...(provider.website ? [new URL(provider.website).hostname.toLowerCase()] : []),
  ];
  for (const kw of keywords) {
    const parts = kw.split(/[.\s_-]+/).filter(Boolean);
    for (const part of parts) {
      if (!KEYWORD_INDEX[part]) KEYWORD_INDEX[part] = [];
      if (!KEYWORD_INDEX[part].includes(provider.providerId)) {
        KEYWORD_INDEX[part].push(provider.providerId);
      }
    }
  }
}

// ─── Discover providers from natural language ───────────────────────

export function discoverProviders(query: string): DiscoveryResult[] {
  const tokens = query.toLowerCase().trim().split(/\s+/);
  const scores: Map<string, { score: number; reason: string }> = new Map();

  for (const token of tokens) {
    const matches = KEYWORD_INDEX[token] || [];
    for (const providerId of matches) {
      const current = scores.get(providerId);
      scores.set(providerId, {
        score: (current?.score || 0) + 1,
        reason: current?.reason || `matched "${token}"`,
      });
    }
  }

  // Also do fuzzy matching on display names
  for (const provider of ALL_PROVIDERS) {
    const displayNameLower = provider.displayName.toLowerCase();
    for (const token of tokens) {
      if (displayNameLower.includes(token) && token.length >= 3) {
        const current = scores.get(provider.providerId);
        scores.set(provider.providerId, {
          score: (current?.score || 0) + 0.5,
          reason: current?.reason || `fuzzy match: ${provider.displayName}`,
        });
      }
    }
  }

  return Array.from(scores.entries())
    .map(([providerId, { score, reason }]) => {
      const manifest = getProviderById(providerId);
      if (!manifest) return null;
      return {
        providerId,
        displayName: manifest.displayName,
        category: manifest.category,
        regions: manifest.regions,
        confidence: Math.min(score / tokens.length, 1.0),
        matchReason: reason,
        bestConnector: selectBestConnector(manifest) as any,
        supportedAuthMethods: getSupportedAuthMethods(manifest) as any,
        capabilities: manifest.capabilities as any,
      } as DiscoveryResult;
    })
    .filter((r): r is DiscoveryResult => r !== null)
    .sort((a, b) => b.confidence - a.confidence);
}

// ─── Best connector selection ────────────────────────────────────────

function selectBestConnector(manifest: any): string {
  if (manifest.apiSupported) return 'api';
  if (manifest.oauthSupported) return 'oauth';
  if (manifest.mcpSupported) return 'mcp';
  if (manifest.pluginSupported) return 'plugin';
  if (manifest.browserSupported) return 'browser';
  return 'generic_web';
}

function getSupportedAuthMethods(manifest: any): string[] {
  const methods: string[] = [];
  if (manifest.apiSupported || manifest.apiKeySupported) methods.push('api_key');
  if (manifest.oauthSupported) methods.push('oauth');
  if (manifest.genericWebSupported || manifest.browserSupported) methods.push('browser_session');
  if (methods.length === 0) methods.push('browser_session'); // fallback
  return methods;
}

// ─── Search by category and region ──────────────────────────────────

export function searchProviders(filters: {
  category?: string;
  region?: string;
  keyword?: string;
  limit?: number;
} = {}): DiscoveryResult[] {
  let results = ALL_PROVIDERS;

  if (filters.category) {
    results = results.filter((p) => p.category === filters.category);
  }
  if (filters.region) {
    results = results.filter((p) => p.regions.includes('global') || p.regions.includes(filters.region));
  }
  if (filters.keyword) {
    const kw = filters.keyword.toLowerCase();
    results = results.filter((p) =>
      p.providerId.toLowerCase().includes(kw) ||
      p.displayName.toLowerCase().includes(kw) ||
      (p.description && p.description.toLowerCase().includes(kw)),
    );
  }

  return results.slice(0, filters.limit || 20).map((p): any => ({
      providerId: p.providerId,
      displayName: p.displayName,
      category: p.category,
      regions: p.regions,
      confidence: 1.0,
      matchReason: 'direct match',
      bestConnector: selectBestConnector(p) as any,
      supportedAuthMethods: getSupportedAuthMethods(p),
      capabilities: p.capabilities || [],
    }));
}
