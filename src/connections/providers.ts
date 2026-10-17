// ================================================================
// Universal Connect Runtime v2 — Provider Registry (thin wrapper)
// Delegates to the comprehensive registry in registry/global.ts
// ================================================================

import { ALL_PROVIDERS, getProviderById, getProvidersByCategory, getProvidersByRegion, TOTAL_PROVIDER_COUNT, CATEGORIES, REGIONS_ALL } from './registry/global';
import { CapabilityDef, ToolDef, RiskLevel } from './types';
import { registerAllConnectors } from './connectors';

// Migrate old PROVIDERS format to new registry for backward compatibility
function toLegacyProvider(manifest: any): any {
  return {
    id: manifest.providerId,
    displayName: manifest.displayName,
    type: toLegacyType(manifest),
    status: manifest.apiSupported || manifest.oauthSupported ? 'active' : 'stub',
    authMethods: manifest.authMethods || ['api'],
    capabilities: (manifest.capabilities || []).map((c: any) => ({
      id: c.id,
      label: c.label,
      riskLevel: c.riskLevel as RiskLevel,
      readOnly: c.readOnly,
    })),
  };
}

function toLegacyType(manifest: any): string {
  if (manifest.apiSupported) return 'api';
  if (manifest.oauthSupported) return 'oauth';
  if (manifest.browserSupported) return 'browser';
  return 'generic_web';
}

// Generate tools from manifest capabilities
function toLegacyTools(manifest: any): ToolDef[] {
  return (manifest.capabilities || []).map((cap: any, idx: number) => ({
    id: `${manifest.providerId}.${cap.id.replace('.', '-')}`,
    version: '1',
    providerId: manifest.providerId,
    capabilities: [cap.id],
    readOnly: cap.readOnly,
    riskLevel: cap.riskLevel || 'R1',
    requiresConfirmation: !cap.readOnly,
    action: cap.id,
    description: cap.label,
  }));
}

// Expose both legacy and new APIs
export const LEGACY_PROVIDERS = ALL_PROVIDERS.map(toLegacyProvider);
export const LEGACY_TOOLS = ALL_PROVIDERS.flatMap(toLegacyTools);

export function getProvider(id: string) {
  return getProviderById(id);
}

export function getTool(id: string) {
  return LEGACY_TOOLS.find((t) => t.id === id);
}

export function providerCapabilities(id: string) {
  const m = getProviderById(id);
  return m?.capabilities || [];
}

export function getProvidersByCategories(cats: string[]) {
  return getProvidersByCategory(cats[0]);
}

export function getRegionalProviders(region: string) {
  return getProvidersByRegion(region);
}

// ─── Startup: register all connectors ──────────────────────────────
registerAllConnectors();

// ─── Stats ─────────────────────────────────────────────────────────
export { TOTAL_PROVIDER_COUNT, CATEGORIES, REGIONS_ALL, ALL_PROVIDERS, getProvidersByCategory, getProvidersByRegion };

// Re-export old interface for backward compatibility
export type { ToolDef, CapabilityDef, RiskLevel } from './types';
