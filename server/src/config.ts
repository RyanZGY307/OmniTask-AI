// ================================================================
// Hardcoded provider base URLs (no longer read from env)
// ================================================================
export const PROVIDER_BASE_URLS = {
  agnes:    'https://apihub.agnes-ai.com/v1',
  agnesRoot: 'https://apihub.agnes-ai.com',
  deepseek: 'https://api.deepseek.com/v1',
  openai:   'https://api.openai.com/v1',
  google:   'https://generativelanguage.googleapis.com/v1beta',
  xiaomi:   'https://api.xiaomi.com/v1',
};

export const env = {
  PORT: parseInt(process.env.PORT || '3001'),
  DATABASE_URL_USER: process.env.DATABASE_URL_USER,
  DATABASE_URL_KNOWLEDGE: process.env.DATABASE_URL_KNOWLEDGE,
  JWT_SECRET: process.env.JWT_SECRET || 'cortex-jwt-secret-change-me',
  CLIENT_URL: process.env.CLIENT_URL || '*',
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@cortex.ai',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  // AIHubMix API Key (MANDATORY in production)
  // Model selection
  AGNES_MODEL: 'agnes-3.0-flash',
  // Network
  GITHUB_API_BASE: process.env.GITHUB_API_BASE || 'https://api.github.com',
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
  GITHUB_OAUTH_REDIRECT_URI: process.env.GITHUB_OAUTH_REDIRECT_URI,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
  VAULT_KEY: process.env.VAULT_KEY,
};

// ================================================================
// MODEL REGISTRY
// costPer1k = credits per 1,000 tokens
// FREE models (AGNES / GEMINI): costPer1k = 0
// ================================================================

export interface ModelRegistryEntry {
  provider: string;
  apiModel: string;
  displayName: string;
  tier: 'FREE' | 'PRO';
  maxTokens: number;
  contextWindow: number;
  costPer1k: number;
  category: string;
  status: 'online' | 'offline' | 'maintenance';
  enabled: boolean;
  lastVerifiedAt: string;
  // Capabilities
  capabilities: string[];
  supportsReasoning: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  // Profiles (1-10 scale)
  qualityProfile: number;
  speedProfile: number;
  reliabilityProfile: number;
  // 厂商显示分类（如 ChatGPT/Claude/Gemini）；空=按 provider 自动推导
  vendor?: string;
}

export const MODEL_REGISTRY: Record<string, ModelRegistryEntry> = {
  // ---- FREE (LLM) ----
  'agnes-2.5-flash': {
    provider: 'agnes',
    apiModel: 'Agnes-2.5-flash',
    displayName: 'Agnes 2.5 Flash',
    tier: 'FREE',
    maxTokens: 8192,
    contextWindow: 32768,
    costPer1k: 0,
    category: 'general',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['conversation', 'qa', 'explanation', 'writing', 'general'],
    supportsReasoning: false,
    supportsTools: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    qualityProfile: 4,
    speedProfile: 9,
    reliabilityProfile: 8,
  },
  'agnes-3.0-flash': {
    provider: 'agnes',
    apiModel: 'Agnes-3.0-flash',
    displayName: 'Agnes 3.0 Flash',
    tier: 'FREE',
    maxTokens: 8192,
    contextWindow: 32768,
    costPer1k: 0,
    category: 'general',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['conversation', 'qa', 'explanation', 'writing', 'general', 'fast'],
    supportsReasoning: false,
    supportsTools: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    qualityProfile: 5,
    speedProfile: 10,
    reliabilityProfile: 9,
  },
  'gemini-3.5-flash': {
    provider: 'google',
    apiModel: 'gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    tier: 'FREE',
    maxTokens: 8192,
    contextWindow: 128000,
    costPer1k: 0,
    category: 'fast',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['fast', 'general', 'conversation', 'qa'],
    supportsReasoning: false,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    qualityProfile: 6,
    speedProfile: 9,
    reliabilityProfile: 8,
  },
  'gemini-3.6-flash': {
    provider: 'google',
    apiModel: 'gemini-3.6-flash',
    displayName: 'Gemini 3.6 Flash',
    tier: 'FREE',
    maxTokens: 8192,
    contextWindow: 128000,
    costPer1k: 0,
    category: 'fast',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['fast', 'general', 'conversation', 'qa', 'coding'],
    supportsReasoning: false,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    qualityProfile: 6,
    speedProfile: 9,
    reliabilityProfile: 8,
  },
  'gemini-3.7-flash': {
    provider: 'google',
    apiModel: 'gemini-3.7-flash',
    displayName: 'Gemini 3.7 Flash',
    tier: 'FREE',
    maxTokens: 8192,
    contextWindow: 128000,
    costPer1k: 0,
    category: 'fast',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['fast', 'general', 'conversation', 'qa', 'coding', 'analysis'],
    supportsReasoning: false,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    qualityProfile: 7,
    speedProfile: 9,
    reliabilityProfile: 8,
  },
  'gemini-3.8-flash': {
    provider: 'google',
    apiModel: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    tier: 'FREE',
    maxTokens: 16384,
    contextWindow: 128000,
    costPer1k: 0,
    category: 'fast',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['fast', 'general', 'conversation', 'qa', 'reasoning', 'coding', 'analysis', 'code_generation', 'debugging', 'search', 'research'],
    supportsReasoning: true,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    qualityProfile: 7,
    speedProfile: 9,
    reliabilityProfile: 8,
  },
  // ---- PRO ----
  'mimo-v2.6-flash': {
    provider: 'xiaomi',
    apiModel: 'MiMo-V2.6-Flash',
    displayName: 'MiMo V2.6 Flash',
    tier: 'PRO',
    maxTokens: 8192,
    contextWindow: 64000,
    costPer1k: 0.233,
    category: 'code',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['fast', 'code', 'general', 'coding', 'code_generation', 'debugging'],
    supportsReasoning: false,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    qualityProfile: 7,
    speedProfile: 9,
    reliabilityProfile: 8,
  },
  'mimo-v2.6-pro': {
    provider: 'xiaomi',
    apiModel: 'MiMo-V2.6-Pro',
    displayName: 'MiMo V2.6 Pro',
    tier: 'PRO',
    maxTokens: 8192,
    contextWindow: 64000,
    costPer1k: 0.728,
    category: 'code',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['reasoning', 'code', 'analysis', 'general', 'coding', 'debugging', 'code_generation'],
    supportsReasoning: true,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    qualityProfile: 8,
    speedProfile: 7,
    reliabilityProfile: 8,
  },
  'deepseek-v4.1-flash': {
    provider: 'deepseek',
    apiModel: 'deepseek-v4.1-flash',
    displayName: 'DeepSeek V4.1 Flash',
    tier: 'PRO',
    maxTokens: 8192,
    contextWindow: 64000,
    costPer1k: 0.667,
    category: 'fast',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['fast', 'code', 'general', 'coding', 'reasoning', 'code_generation', 'debugging'],
    supportsReasoning: true,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    supportsStructuredOutput: false,
    qualityProfile: 7,
    speedProfile: 9,
    reliabilityProfile: 8,
  },
  'gpt-5.6-luna': {
    provider: 'openai',
    apiModel: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    tier: 'PRO',
    maxTokens: 16384,
    contextWindow: 128000,
    costPer1k: 1.0,
    category: 'fast',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['fast', 'general', 'writing', 'conversation', 'qa', 'code_generation', 'coding'],
    supportsReasoning: false,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    qualityProfile: 7,
    speedProfile: 8,
    reliabilityProfile: 9,
  },
  'gpt-5.6-terra': {
    provider: 'openai',
    apiModel: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    tier: 'PRO',
    maxTokens: 32768,
    contextWindow: 128000,
    costPer1k: 10.0,
    category: 'reasoning',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['reasoning', 'complex', 'analysis', 'research', 'coding', 'general', 'code_generation', 'debugging'],
    supportsReasoning: true,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    qualityProfile: 9,
    speedProfile: 6,
    reliabilityProfile: 9,
  },
   // ---- PRO (flagship, formerly ULTRA) ----
  'mimo-v2.6-ultraspeed': {
    provider: 'xiaomi',
    apiModel: 'MiMo-V2.6-UltraSpeed',
    displayName: 'MiMo V2.6 UltraSpeed',
    tier: 'PRO',
    maxTokens: 16384,
    contextWindow: 64000,
    costPer1k: 7.25,
    category: 'flagship',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['flagship', 'fast', 'code', 'general', 'reasoning', 'coding', 'code_generation', 'debugging'],
    supportsReasoning: true,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    qualityProfile: 8,
    speedProfile: 10,
    reliabilityProfile: 8,
  },
  'deepseek-v4-pro': {
    provider: 'deepseek',
    apiModel: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    tier: 'PRO',
    maxTokens: 16384,
    contextWindow: 128000,
    costPer1k: 2.2,
    category: 'reasoning',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['reasoning', 'complex', 'analysis', 'research', 'coding', 'general', 'code_generation', 'debugging', 'search', 'citation'],
    supportsReasoning: true,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    qualityProfile: 9,
    speedProfile: 7,
    reliabilityProfile: 9,
  },
  'gpt-5.6-sol': {
    provider: 'openai',
    apiModel: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    tier: 'PRO',
    maxTokens: 32768,
    contextWindow: 128000,
    costPer1k: 16.667,
    category: 'code',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['code', 'reasoning', 'complex', 'coding', 'debugging', 'code_generation', 'general'],
    supportsReasoning: true,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    qualityProfile: 10,
    speedProfile: 6,
    reliabilityProfile: 9,
  },
  'gpt-6-astra': {
    provider: 'openai',
    apiModel: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    tier: 'PRO',
    maxTokens: 65536,
    contextWindow: 200000,
    costPer1k: 41.667,
    category: 'flagship',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['reasoning', 'complex', 'research', 'analysis', 'flagship', 'coding', 'general', 'code_generation', 'debugging', 'search', 'citation'],
    supportsReasoning: true,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsStructuredOutput: true,
    qualityProfile: 10,
    speedProfile: 5,
    reliabilityProfile: 9,
  },
  // ---- Media (image / video) — handled via separate endpoints ----
  'agnes-image-2.5-flash': {
    provider: 'agnes',
    apiModel: 'agnes-image-2.5-flash',
    displayName: 'Agnes Image 2.5 Flash',
    tier: 'FREE',
    category: 'image',
    costPer1k: 0,
    maxTokens: 0,
    contextWindow: 0,
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['image_generation'],
    supportsReasoning: false,
    supportsTools: false,
    supportsVision: false,
    supportsStreaming: false,
    supportsStructuredOutput: false,
    qualityProfile: 7,
    speedProfile: 6,
    reliabilityProfile: 9,
  },
  'agnes-image-2.1-flash': {
    provider: 'agnes',
    apiModel: 'agnes-image-2.1-flash',
    displayName: 'Agnes Image 2.1 Flash',
    tier: 'FREE',
    category: 'image',
    costPer1k: 0,
    maxTokens: 0,
    contextWindow: 0,
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['image_generation'],
    supportsReasoning: false,
    supportsTools: false,
    supportsVision: false,
    supportsStreaming: false,
    supportsStructuredOutput: false,
    qualityProfile: 6,
    speedProfile: 7,
    reliabilityProfile: 9,
  },
  'agnes-image-2.0-flash': {
    provider: 'agnes',
    apiModel: 'agnes-image-2.0-flash',
    displayName: 'Agnes Image 2.0 Flash',
    tier: 'FREE',
    category: 'image',
    costPer1k: 0,
    maxTokens: 0,
    contextWindow: 0,
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['image_generation'],
    supportsReasoning: false,
    supportsTools: false,
    supportsVision: false,
    supportsStreaming: false,
    supportsStructuredOutput: false,
    qualityProfile: 5,
    speedProfile: 8,
    reliabilityProfile: 8,
  },
  'agnes-video-2.5-flash': {
    provider: 'agnes',
    apiModel: 'agnes-video-2.5-flash',
    displayName: 'Agnes Video 2.5 Flash',
    tier: 'FREE',
    category: 'video',
    costPer1k: 0,
    maxTokens: 0,
    contextWindow: 0,
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['video_generation'],
    supportsReasoning: false,
    supportsTools: false,
    supportsVision: false,
    supportsStreaming: false,
    supportsStructuredOutput: false,
    qualityProfile: 6,
    speedProfile: 4,
    reliabilityProfile: 8,
  },
  'agnes-video-v2.0': {
    provider: 'agnes',
    apiModel: 'agnes-video-v2.0',
    displayName: 'Agnes Video v2.0',
    tier: 'FREE',
    category: 'video',
    costPer1k: 0,
    maxTokens: 0,
    contextWindow: 0,
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['video_generation'],
    supportsReasoning: false,
    supportsTools: false,
    supportsVision: false,
    supportsStreaming: false,
    supportsStructuredOutput: false,
    qualityProfile: 7,
    speedProfile: 3,
    reliabilityProfile: 8,
  },

  // ---- AUDIO / TTS (FREE UNLIMITED capability) — capability registry:
  //   server/src/services/audio/ttsRegistry.ts is the single source of
  //   truth for per-model formats & voice capability. These registry
  //   entries exist so getUserAvailableModels() lists them (audio
  //   bypasses tier filtering like image/video) and so the model
  //   pool / entitlement layer sees the audio capability.
  'mimo-v2.5-tts': {
    provider: 'xiaomi',
    apiModel: 'mimo-v2.5-tts',
    displayName: 'Xiaomi MiMo TTS',
    tier: 'FREE',
    maxTokens: 0,
    contextWindow: 0,
    costPer1k: 0,
    category: 'audio',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['audio_generation', 'style_instruction'],
    supportsReasoning: false,
    supportsTools: false,
    supportsVision: false,
    supportsStreaming: false,
    supportsStructuredOutput: false,
    qualityProfile: 6,
    speedProfile: 8,
    reliabilityProfile: 8,
  },
  'mimo-v2.5-tts-voiceclone': {
    provider: 'xiaomi',
    apiModel: 'mimo-v2.5-tts-voiceclone',
    displayName: 'Xiaomi MiMo TTS Voice Clone',
    tier: 'FREE',
    maxTokens: 0,
    contextWindow: 0,
    costPer1k: 0,
    category: 'audio',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['audio_generation', 'voice_clone'],
    supportsReasoning: false,
    supportsTools: false,
    supportsVision: false,
    supportsStreaming: false,
    supportsStructuredOutput: false,
    qualityProfile: 6,
    speedProfile: 8,
    reliabilityProfile: 8,
  },
  'mimo-v2.5-tts-voicedesign': {
    provider: 'xiaomi',
    apiModel: 'mimo-v2.5-tts-voicedesign',
    displayName: 'Xiaomi MiMo TTS Voice Design',
    tier: 'FREE',
    maxTokens: 0,
    contextWindow: 0,
    costPer1k: 0,
    category: 'audio',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['audio_generation', 'voice_design'],
    supportsReasoning: false,
    supportsTools: false,
    supportsVision: false,
    supportsStreaming: false,
    supportsStructuredOutput: false,
    qualityProfile: 6,
    speedProfile: 8,
    reliabilityProfile: 8,
  },
  'gemini-3.8-flash-tts': {
    provider: 'google',
    apiModel: 'gemini-3.8-flash-tts',
    displayName: 'Gemini 3.8 Flash TTS',
    tier: 'FREE',
    maxTokens: 0,
    contextWindow: 0,
    costPer1k: 0,
    category: 'audio',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['audio_generation', 'voice_design', 'voice_replication', 'style_instruction'],
    supportsReasoning: false,
    supportsTools: false,
    supportsVision: false,
    supportsStreaming: false,
    supportsStructuredOutput: false,
    qualityProfile: 7,
    speedProfile: 8,
    reliabilityProfile: 8,
  },
  'gemini-3.8-flash-lite-tts': {
    provider: 'google',
    apiModel: 'gemini-3.8-flash-lite-tts',
    displayName: 'Gemini 3.8 Flash-Lite TTS',
    tier: 'FREE',
    maxTokens: 0,
    contextWindow: 0,
    costPer1k: 0,
    category: 'audio',
    status: 'online',
    enabled: true,
    lastVerifiedAt: new Date().toISOString(),
    capabilities: ['audio_generation', 'voice_design', 'voice_replication', 'style_instruction'],
    supportsReasoning: false,
    supportsTools: false,
    supportsVision: false,
    supportsStreaming: false,
    supportsStructuredOutput: false,
    qualityProfile: 6,
    speedProfile: 9,
    reliabilityProfile: 8,
  },
};

// ================================================================
// PRICING
// ================================================================

// Subscription tiers: the Ultra tier was retired in this release. Legacy
// ULTRA subscriptions still exist in user rows and resolve to the PRO
// model/entitlement set (they keep every model Pro now ships).
export const PRICING = {
  PRO: { monthly: 9.9, yearly: 99, creditGrant: 3000 },
};

// Pro subscription credits are granted in monthly batches (30-day validity),
// never as a single large grant. Yearly plans issue 12 such batches.
export const PRO_CREDIT_BATCH = { credits: 3000, validDays: 30, monthly: 1, yearly: 12 };

// Frozen legacy price for in-flight Ultra orders only — no new sales.
// Resolved by paymentRuntime when an old ultra_* order completes payment.
export const LEGACY_ULTRA_PRICING = { monthly: 20, yearly: 188, creditGrant: 5000 };

// Top-up credit packs. Permanent validity — credits never expire.
export const CREDIT_PACKS = [
  { id: 'pack-300', credits: 300, price: 1.09, currency: 'USD' },
  { id: 'pack-600', credits: 600, price: 1.99, currency: 'USD' },
  { id: 'pack-1200', credits: 1200, price: 3.59, currency: 'USD' },
  { id: 'pack-2400', credits: 2400, price: 6.49, currency: 'USD' },
  { id: 'pack-5000', credits: 5000, price: 12.89, currency: 'USD' },
  { id: 'pack-10000', credits: 10000, price: 24.99, currency: 'USD' },
  { id: 'pack-15000', credits: 15000, price: 35.99, currency: 'USD' },
];

// Credit packs are permanent: a far-future batch expiry keeps them active
// in getActiveBatches() forever without schema changes.
export const PERMANENT_PACK_VALID_DAYS = 36500; // ~100 years

// ================================================================
// DYNAMIC PRICING GUARDRAILS (spec R4, R5)
// ================================================================

export const PRICING_GUARDRAILS = {
  targetMargin: 0.30,
  lowMargin: 0.20,
  highMargin: 0.40,
  adjustStep: 0.05,
  minPriceFactor: 0.80,
  maxPriceFactor: 1.50,
  maxPublishesPerDay: 1,
  costProtectionFactor: 1.15,
  costFxRate: 4.50,
};

// Subscription credit grants stay fixed across price adjustments (R11.6).
// ULTRA is legacy-only (no new sales); kept so in-flight orders / existing
// subscriptions still resolve a grant amount.
export const SUBSCRIPTION_GRANTS = {
  PRO: 3000,
  // Legacy Ultra (in-flight orders only) — 5000 single grant, no batches.
  ULTRA: 5000,
};

// ================================================================
// PAYMENT
// ================================================================

export const RECIPIENTS: Record<string, { name: string; label: string }[]> = {
  tng: [{ name: 'RYAN TIONG KWONG NGIE', label: 'TNG' }],
  shopeepay: [{ name: 'RYAN TIONG KWONG NGIE', label: 'ShopeePay' }],
  alipay: [{ name: '张光义', label: 'Alipay' }],
  paypal: [{ name: 'RYAN TIONG KWONG NGIE', label: 'PayPal' }],
};

// ================================================================
// HELPERS
// ================================================================

export function getUserAvailableModels(user: any): any[] {
  const effectiveTier = user.subscriptionTier || 'STANDARD';
  // ULTRA is a retired legacy tier — it maps to PRO so existing Ultra
  // accounts keep the full model set (flagship models are now PRO).
  const tierOrder = ['STANDARD', 'PRO', 'ULTRA'];
  const tierIndex = effectiveTier === 'ULTRA' ? 1 : tierOrder.indexOf(effectiveTier);
  // Lazy require breaks the config <-> configSync circular import at
  // module-eval time. Path is relative to the COMPILED file
  // (dist/config.js), so it must be './services/...', not '../services/...'
  // (the source-tree path). A wrong relative path throws MODULE_NOT_FOUND
  // at request time and crashes the process on the first call.
  const models = (require('./services/configSync').getDynamicModels()) || MODEL_REGISTRY;

  return Object.entries(models)
    .filter(([, info]: [string, any]) => {
      if (info.category === 'image' || info.category === 'video' || info.category === 'audio') return true;
      const modelTierIndex = tierOrder.indexOf(info.tier);
      return modelTierIndex <= tierIndex;
    })
    .map(([key, info]: [string, any]) => ({ key, ...info }))
    .sort((a: any, b: any) => {
      const tierIdx: Record<string, number> = { FREE: 0, PRO: 1 };
      return (tierIdx[a.tier] ?? 1) - (tierIdx[b.tier] ?? 1);
    });
}
