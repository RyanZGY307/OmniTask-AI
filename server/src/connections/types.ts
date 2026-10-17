// ================================================================
// Universal Connect Runtime v2 — Shared Types
// ================================================================

export interface ProviderDef {
  id: string;
  displayName: string;
  type: string;
  capabilities: CapabilityDef[];
  authMethods: string[];
  status: 'active' | 'stub';
}

export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

export type PolicyValue = 'auto' | 'confirm' | 'always' | 'never';

export type ActionPolicy = Record<RiskLevel, PolicyValue>;

export interface CapabilityDef {
  id: string;
  label: string;
  riskLevel: RiskLevel;
  readOnly: boolean;
}

// Connector types

// Provider Implementation Level (P0-4)
export type ImplLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export function computeImplLevel(manifest: {
  apiSupported: boolean;
  oauthSupported: boolean;
  apiKeySupported: boolean;
  browserSupported: boolean;
  capabilities?: any[];
  healthCheckUrl?: string;
  version?: string;
}): ImplLevel {
  // L4: Full — has explicit health check, version, multiple capabilities
  if (manifest.healthCheckUrl && manifest.version && manifest.capabilities && manifest.capabilities.length >= 5) return 'L4';
  // L3: Advanced — has API or OAuth + capabilities
  if ((manifest.apiSupported || manifest.oauthSupported) && manifest.capabilities && manifest.capabilities.length >= 3) return 'L3';
  // L2: Functional — has API or OAuth
  if (manifest.apiSupported || manifest.oauthSupported) return 'L2';
  // L1: Connected — browser only
  if (manifest.browserSupported) return 'L1';
  // L0: Catalog only
  return 'L0';
}

export type ConnectorType = 'api' | 'oauth' | 'mcp' | 'plugin' | 'browser' | 'generic_web';

// Auth methods
export type AuthMethod = 'oauth' | 'api_key' | 'username_password' | 'browser_session' | 'mcp' | 'plugin';

// Provider health status
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

// Task run status
export type TaskStatus =
  | 'created' | 'queued' | 'running' | 'waiting_approval' | 'waiting_auth'
  | 'paused' | 'resuming' | 'completed' | 'failed' | 'cancelled' | 'timeout';

// Provider type
export type ProviderType = 'first-party' | 'third-party' | 'mcp' | 'plugin' | 'browser' | 'generic_web';

// ================================================================
// PlatformManifest — unified provider manifest
// ================================================================

export interface PlatformManifestDef {
  providerId: string;
  displayName: string;
  category: string;
  subcategories?: string[];
  regions: string[];           // ISO 3166-1 alpha-2 or 'global'
  description?: string;
  website?: string;
  apiSupported: boolean;
  oauthSupported: boolean;
  apiKeySupported: boolean;
  mcpSupported: boolean;
  browserSupported: boolean;
  pluginSupported: boolean;
  genericWebSupported: boolean;
  multiAccount: boolean;
  mobileSupported: boolean;
  desktopSupported: boolean;
  webSupported: boolean;
  defaultRiskLevel: RiskLevel;
  implLevel?: ImplLevel;
  rateLimit?: string;
  documentationUrl?: string;
  healthCheckUrl?: string;
  version?: string;
  tools?: ToolDef[];
  capabilities?: CapabilityDef[];
  scopes?: string[];
}

// ================================================================
// Tool Definition (extended)
// ================================================================

export interface ToolDef {
  id: string;
  version: string;
  providerId: string;
  capabilities: string[];
  readOnly: boolean;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  action: string;
  description?: string;
  inputSchema?: Record<string, any>;
  outputSchema?: Record<string, any>;
}

// ================================================================
// Connection runtime types
// ================================================================

export interface ConnectionAccount {
  id: string;
  accountName: string;
  accountIdentifier: string;
  isConnected: boolean;
  lastActiveAt?: Date;
  permissions: string[];
}

export interface ConnectionView {
  id: string;
  providerId: string;
  providerName: string;
  type: string;
  authMethod: string;
  status: string;
  permissions: string[];
  scopes: string[];
  accountName?: string;
  accountIdentifier?: string;
  platformManifestId?: string;
  lastHealthCheck?: Date;
  lastTokenRefresh?: Date;
  multiAccount?: boolean;
  accounts?: ConnectionAccount[];
  createdAt: Date;
  updatedAt: Date;
}

// ================================================================
// Authentication
// ================================================================

export interface ConnectorContext {
  userId: string;
  connectionId: string;
  credentialId: string;
  accountId?: string;
  sessionId?: string;
  traceId?: string;
  requestId?: string;
  taskRunId?: string;
}

export interface AuthResult {
  success: boolean;
  connectionId?: string;
  credentialId?: string;
  accountId?: string;
  accountName?: string;
  requiresMfa?: boolean;
  mfaCode?: string;
  mfaType?: 'totp' | 'sms' | 'email' | 'push' | 'passkey';
  mfaChallenge?: string;
  sessionToken?: string;
  error?: string;
}

export interface MfaChallenge {
  type: 'totp' | 'sms' | 'email' | 'push' | 'passkey';
  challenge: string;
  expiresIn: number;
}

// ================================================================
// Browser runtime
// ================================================================

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  isActive: boolean;
  createdAt: Date;
}

export interface BrowserActionResult {
  ok: boolean;
  url?: string;
  screenshot?: string;
  content?: string;
  error?: string;
  action?: string;
  verified?: boolean;
  verifyResult?: any;
}

// ================================================================
// Plugin / MCP
// ================================================================

export interface PluginDef {
  id: string;
  name: string;
  version: string;
  description?: string;
  manifest: Record<string, any>;
  installedAt: Date;
  status: string;
}

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

// ================================================================
// File Bridge
// ================================================================

export interface FileBridgeEntry {
  id: string;
  sourceType: string;
  sourceId?: string;
  destinationType?: string;
  destinationId?: string;
  mimeType?: string;
  fileSize?: number;
  sha256?: string;
  status: string;
  metadata?: any;
  createdAt: Date;
}

// ================================================================
// Provider Health
// ================================================================

export interface ProviderHealthEntry {
  id: string;
  platformManifestId: string;
  connectorType: string;
  status: HealthStatus;
  availability?: number;
  latencyMs?: number;
  errorRate?: number;
  rateLimitRemaining?: number;
  quotaUsed?: number;
  quotaTotal?: number;
  retryAfter?: number;
  errorMessage?: string;
  checkedAt: Date;
}

export interface ProviderHealthSummary {
  providerId: string;
  displayName: string;
  overallStatus: HealthStatus;
  lastCheckAt?: Date;
  errorRate?: number;
  connectivity: Record<string, HealthStatus>;
}

// ================================================================
// Task Runner
// ================================================================

export interface TaskRunEntry {
  id: string;
  userId: string;
  conversationId?: string;
  title?: string;
  providerId?: string;
  connectionId?: string;
  taskType: string;
  status: TaskStatus;
  progress: number;
  checkpoint?: any;
  result?: any;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  timeoutAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ================================================================
// Discovery
// ================================================================

export interface DiscoveryResult {
  providerId: string;
  displayName: string;
  category: string;
  regions: string[];
  confidence: number;
  matchReason: string;
  bestConnector: ConnectorType;
  supportedAuthMethods: AuthMethod[];
  capabilities: CapabilityDef[];
}

// ================================================================
// Execution
// ================================================================

export interface ExecutionContext {
  userId: string;
  connectionId?: string;
  accountId?: string;
  toolId: string;
  args: Record<string, any>;
  traceId?: string;
  requestId?: string;
  taskRunId?: string;
}

export interface ExecutionResult {
  ok: boolean;
  verified: boolean;
  data?: any;
  error?: string;
  requiresApproval?: boolean;
  approvalPreview?: any;
  warnings?: string[];
}
