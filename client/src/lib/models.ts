export interface ModelInfo {
  key?: string;
  provider: string;
  apiModel: string;
  costPer1k: number;
  tier: 'FREE' | 'PRO' | 'ULTRA';
  category: string;
  displayName: string;
  capabilities?: string[];
  contextWindow?: number;
  maxTokens?: number;
  supportsReasoning?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  qualityProfile?: number;
  speedProfile?: number;
  reliabilityProfile?: number;
}

// A model entry with a populated key (what getUserAvailableModels returns).
export type ModelInfoKeyed = ModelInfo & { key: string };

export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  // LLM 模型列表与积分已清空：用户端可选模型与消耗积分一律以 admin
  // （/admin/models 录入 ModelConfig）为准，经 GET /api/models 实时下发。
  // 此处仅保留媒体/音频/办公的能力元数据（非对话模型选择）。

  // IMAGE (FREE, always available)
  'agnes-image-2.5-flash': { provider: 'agnes',   apiModel: 'agnes-image-2.5-flash',    costPer1k: 0, tier: 'FREE',  category: 'image', displayName: 'Agnes Image 2.5 Flash' },
  'agnes-image-2.1-flash': { provider: 'agnes',   apiModel: 'agnes-image-2.1-flash',    costPer1k: 0, tier: 'FREE',  category: 'image', displayName: 'Agnes Image 2.1 Flash' },
  'agnes-image-2.0-flash': { provider: 'agnes',   apiModel: 'agnes-image-2.0-flash',    costPer1k: 0, tier: 'FREE',  category: 'image', displayName: 'Agnes Image 2.0 Flash' },

  // VIDEO (FREE, always available)
  'agnes-video-2.5-flash': { provider: 'agnes',   apiModel: 'agnes-video-2.5-flash',    costPer1k: 0, tier: 'FREE',  category: 'video', displayName: 'Agnes Video 2.5 Flash' },
  'agnes-video-v2.0':      { provider: 'agnes',   apiModel: 'agnes-video-v2.0',         costPer1k: 0, tier: 'FREE',  category: 'video', displayName: 'Agnes Video v2.0' },

  // AUDIO / TTS (FREE UNLIMITED capability — see credits.ts)
  'mimo-v2.5-tts':             { provider: 'xiaomi', apiModel: 'mimo-v2.5-tts',          costPer1k: 0, tier: 'FREE', category: 'audio', displayName: 'Xiaomi MiMo TTS', capabilities: ['audio_generation'] },
  'mimo-v2.5-tts-voiceclone':  { provider: 'xiaomi', apiModel: 'mimo-v2.5-tts-voiceclone', costPer1k: 0, tier: 'FREE', category: 'audio', displayName: 'Xiaomi MiMo TTS Voice Clone', capabilities: ['audio_generation'] },
  'mimo-v2.5-tts-voicedesign': { provider: 'xiaomi', apiModel: 'mimo-v2.5-tts-voicedesign', costPer1k: 0, tier: 'FREE', category: 'audio', displayName: 'Xiaomi MiMo TTS Voice Design', capabilities: ['audio_generation'] },
  'gemini-3.8-flash-tts':      { provider: 'google', apiModel: 'gemini-3.8-flash-tts',   costPer1k: 0, tier: 'FREE', category: 'audio', displayName: 'Gemini 3.8 Flash TTS', capabilities: ['audio_generation'] },
  'gemini-3.8-flash-lite-tts': { provider: 'google', apiModel: 'gemini-3.8-flash-lite-tts', costPer1k: 0, tier: 'FREE', category: 'audio', displayName: 'Gemini 3.8 Flash-Lite TTS', capabilities: ['audio_generation'] },
};

// ULTRA is a retired tier: legacy Ultra accounts resolve to the PRO rung
// so they keep the full model set Pro now ships.
const TIER_HIERARCHY: Record<string, number> = { STANDARD: 0, PRO: 1, ULTRA: 1 };

export function getUserAvailableModels(user: {
  subscriptionTier: string;
}): ModelInfoKeyed[] {
  return Object.entries(MODEL_REGISTRY)
    .filter(([_, info]) => {
      if (info.category === 'image' || info.category === 'video' || info.category === 'audio') return true;
      return TIER_HIERARCHY[user.subscriptionTier] >= TIER_HIERARCHY[info.tier];
    })
    .map(([key, info]) => ({ key, ...info }))
    .sort((a, b) => (TIER_HIERARCHY[a.tier] ?? 1) - (TIER_HIERARCHY[b.tier] ?? 1));
}

export function getEffectiveTier(user: { subscriptionTier: string }): string {
  return user.subscriptionTier;
}

export function formatCredits(c: number): string {
  return Math.floor(c).toString();
}

export function getModelDisplayCost(key: string): string {
  const model = MODEL_REGISTRY[key];
  if (!model) return '';
  if (model.costPer1k === 0) return '免费';
  return `$${model.costPer1k.toFixed(2)}/M`;
}

// 将内部模型 key（如 gemini-3.7-flash）映射为面向用户的显示名；
// 未知 key 原样返回。历史消息中的 key 也可能命中注册表之外的旧模型。
export function getModelDisplayName(key?: string | null): string | undefined {
  if (!key) return undefined;
  return MODEL_REGISTRY[key]?.displayName ?? key;
}

// token 数量的人类可读格式化：1488 → 1.5K，用于消息元数据行
export function formatTokenCount(n: number): string {
  if (n >= 10000) return (n / 1000).toFixed(1) + 'K';
  if (n >= 1000) return (n / 1000).toFixed(2) + 'K';
  return String(n);
}

// ==================== Pricing ====================

// Pro is the only sellable tier: $9.9/month, $99/year, 3000 credits/month
// (yearly = 12 monthly batches of 3000, each valid 30 days). The Ultra
// tier was retired; its frozen price is kept so in-flight ultra_* orders /
// legacy subscriptions still settle correctly.
export const PRICING = {
  PRO: {
    monthly: 9.9,
    yearly: 99,
    creditGrant: 3000,
  },
};

export const LEGACY_ULTRA_PRICING = {
  monthly: 20,
  yearly: 188,
  creditGrant: 5000,
};

export const CREDIT_PACKS = [
  { id: 'pack-300',   credits: 300,   price: 1.09,  expiryDays: 0 },
  { id: 'pack-600',   credits: 600,   price: 1.99,  expiryDays: 0 },
  { id: 'pack-1200',  credits: 1200,  price: 3.59,  expiryDays: 0 },
  { id: 'pack-2400',  credits: 2400,  price: 6.49,  expiryDays: 0 },
  { id: 'pack-5000',  credits: 5000,  price: 12.89, expiryDays: 0 },
  { id: 'pack-10000', credits: 10000, price: 24.99, expiryDays: 0 },
  { id: 'pack-15000', credits: 15000, price: 35.99, expiryDays: 0 },
];

// ==================== 媒体生成参数元数据 ====================

// 图片模型确认卡片选项
export const IMAGE_MODELS_CONFIRM = [
  { key: 'agnes-image-2.0-flash', displayName: 'Agnes Image 2.0 Flash' },
  { key: 'agnes-image-2.1-flash', displayName: 'Agnes Image 2.1 Flash' },
  { key: 'agnes-image-2.5-flash', displayName: 'Agnes Image 2.5 Flash' },
];

export const IMAGE_RATIOS_CONFIRM = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'] as const;
export const IMAGE_RESOLUTIONS_CONFIRM = ['1K', '2K', '3K', '4K'] as const; // 1080P 请求时按 1K 处理

// 视频：固定 agnes-video-2.5-flash + 720P
export const VIDEO_MODEL_CONFIRM = 'agnes-video-2.5-flash';
export const VIDEO_RESOLUTION_CONFIRM = '720P';
export const VIDEO_RATIOS_CONFIRM = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;
export const VIDEO_SECONDS_CONFIRM = [4, 5, 8, 10, 12] as const;

// 音频生成（TTS）—— 模型/格式能力映射。
// 该表与后端 TTS Capability Registry（server ttsRegistry.ts）保持一致，
// 前端负责动态联动：切换模型时按该表过滤格式；不兼容格式自动回退默认。
export type AudioFormat = 'wav' | 'mp3' | 'pcm' | 'pcm16' | 'mulaw' | 'alaw';
export interface TtsModel {
  modelId: string;
  provider: 'xiaomi' | 'gemini';
  displayName: string;
  supportedFormats: AudioFormat[];
  supportsVoiceDesign: boolean;
  supportsVoiceClone: boolean;
  supportsStyleInstruction: boolean;
  defaultFormat: AudioFormat;
  requiresVoiceReference: boolean;
}

export const TTS_MODELS_CONFIRM: TtsModel[] = [
  {
    modelId: 'mimo-v2.5-tts',
    provider: 'xiaomi',
    displayName: 'Xiaomi MiMo TTS',
    supportedFormats: ['wav', 'mp3', 'pcm', 'pcm16'],
    supportsVoiceDesign: false,
    supportsVoiceClone: false,
    supportsStyleInstruction: true,
    defaultFormat: 'wav',
    requiresVoiceReference: false,
  },
  {
    modelId: 'mimo-v2.5-tts-voiceclone',
    provider: 'xiaomi',
    displayName: 'Xiaomi MiMo TTS Voice Clone',
    supportedFormats: ['wav', 'mp3', 'pcm', 'pcm16'],
    supportsVoiceDesign: false,
    supportsVoiceClone: true,
    supportsStyleInstruction: true,
    defaultFormat: 'wav',
    requiresVoiceReference: true,
  },
  {
    modelId: 'mimo-v2.5-tts-voicedesign',
    provider: 'xiaomi',
    displayName: 'Xiaomi MiMo TTS Voice Design',
    supportedFormats: ['wav', 'mp3', 'pcm', 'pcm16'],
    supportsVoiceDesign: true,
    supportsVoiceClone: false,
    supportsStyleInstruction: false,
    defaultFormat: 'wav',
    requiresVoiceReference: false,
  },
  {
    modelId: 'gemini-3.8-flash-tts',
    provider: 'gemini',
    displayName: 'Gemini 3.8 Flash TTS',
    supportedFormats: ['wav', 'pcm', 'mulaw', 'alaw'],
    supportsVoiceDesign: true,
    supportsVoiceClone: true,
    supportsStyleInstruction: true,
    defaultFormat: 'wav',
    requiresVoiceReference: false,
  },
  {
    modelId: 'gemini-3.8-flash-lite-tts',
    provider: 'gemini',
    displayName: 'Gemini 3.8 Flash-Lite TTS',
    supportedFormats: ['wav', 'pcm', 'mulaw', 'alaw'],
    supportsVoiceDesign: true,
    supportsVoiceClone: true,
    supportsStyleInstruction: true,
    defaultFormat: 'wav',
    requiresVoiceReference: false,
  },
];

export const AUDIO_FORMAT_LABELS: Record<AudioFormat, string> = {
  wav: 'WAV',
  mp3: 'MP3',
  pcm: 'PCM',
  pcm16: 'PCM16',
  mulaw: 'Mu-law',
  alaw: 'A-law',
};

export function getTtsModel(modelId: string): TtsModel | undefined {
  return TTS_MODELS_CONFIRM.find((m) => m.modelId === modelId);
}

// When the user switches TTS models, the current format may be illegal
// for the new model. Return true if it must auto-reset to the default.
export function formatInvalidForModel(modelId: string, format: AudioFormat): boolean {
  const m = getTtsModel(modelId);
  return !m || !m.supportedFormats.includes(format);
}

// ==================== Office / Document generation metadata ====================
// Mirrors server services/office/types.ts (OFFICE_FORMATS + FORMATS_FOR_TYPE).
// The LLM only produces the structured spec; the deterministic renderer
// produces the binary. No provider / model names here.

export type OfficeFormat = 'pptx' | 'ppt' | 'docx' | 'pdf' | 'xlsx' | 'xls';
export type OfficeArtifactType = 'presentation' | 'document' | 'spreadsheet';

export const OFFICE_FORMATS: OfficeFormat[] = ['pptx', 'ppt', 'docx', 'pdf', 'xlsx', 'xls'];

export const OFFICE_FORMAT_LABELS: Record<OfficeFormat, string> = {
  pptx: 'PPTX', ppt: 'PPT（旧版）', docx: 'DOCX', pdf: 'PDF', xlsx: 'XLSX', xls: 'XLS（旧版）',
};

// Which output formats each artifact type can be rendered into.
export const OFFICE_FORMATS_BY_TYPE: Record<OfficeArtifactType, OfficeFormat[]> = {
  presentation: ['pptx', 'ppt', 'pdf'],
  document: ['docx', 'pdf'],
  spreadsheet: ['xlsx', 'xls'],
};

// Default output format per artifact type (single source shared with
// server routes/office.ts DEFAULT_FORMATS).
export const OFFICE_DEFAULT_FORMAT: Record<OfficeArtifactType, OfficeFormat> = {
  presentation: 'pptx',
  document: 'docx',
  spreadsheet: 'xlsx',
};

export const OFFICE_TYPE_LABELS: Record<OfficeArtifactType, string> = {
  presentation: '演示文稿',
  document: '文档',
  spreadsheet: '表格',
};

// Common document sub-types shown in the spec card.
export const OFFICE_DOCUMENT_TYPES = ['prd', 'report', 'meeting-notes', 'manual', 'general'] as const;
export const OFFICE_DOCUMENT_TYPE_LABELS: Record<string, string> = {
  prd: 'PRD 需求文档',
  report: '报告',
  'meeting-notes': '会议纪要',
  manual: '手册 / 说明书',
  general: '通用文档',
};

export function officeFormatsForType(t: OfficeArtifactType): OfficeFormat[] {
  return OFFICE_FORMATS_BY_TYPE[t] ?? [OFFICE_DEFAULT_FORMAT[t]];
}
export function defaultOfficeFormat(t: OfficeArtifactType): OfficeFormat {
  return OFFICE_DEFAULT_FORMAT[t];
}

// ==================== 模型分组 (Model Groups) ====================
// The CapsuleBar "模型" selector is grouped by provider family, each
// labeled 免费 / 消耗积分. Groups are built LIVE from the backend model
// catalog (GET /api/models, admin-managed): the list of models an admin
// adds/removes in /admin/models is what the user sees — no static
// wish-list to drift out of sync.

export type ModelGroupLabel = '免费' | '消耗积分';

export interface ModelGroup {
  provider: string;        // internal provider key (matches ModelInfo.provider)
  label: string;           // display name for the group row
  costLabel: ModelGroupLabel;
  // Model keys in select order (cheapest first). Already filtered to what
  // the user can actually use (server-side tier filter).
  keys: string[];
  // Default (cheapest) model key inside the group.
  defaultKey: string;
}

// Provider family display names + preferred row order. Unknown providers
// (admin-added custom families) are appended after the known ones.
export const PROVIDER_LABELS: Record<string, string> = {
  google: 'Gemini',
  agnes: 'Agnes',
  openai: 'ChatGPT',
  deepseek: 'DeepSeek',
  xiaomi: 'Xiaomi MiMO',
  custom: '自定义',
};

const PROVIDER_ORDER = ['google', 'agnes', 'openai', 'deepseek', 'xiaomi'];

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] || provider;
}

// Build presentation groups from the live catalog's LLM models.
export function buildModelGroups(models: ModelInfoKeyed[]): ModelGroup[] {
  const byProvider = new Map<string, ModelInfoKeyed[]>();
  for (const m of models) {
    if (m.category === 'image' || m.category === 'video' || m.category === 'audio') continue;
    const arr = byProvider.get(m.provider) || [];
    arr.push(m);
    byProvider.set(m.provider, arr);
  }
  const known = PROVIDER_ORDER.filter((p) => byProvider.has(p));
  const custom = [...byProvider.keys()].filter((p) => !PROVIDER_ORDER.includes(p));

  const groups: ModelGroup[] = [];
  for (const provider of [...known, ...custom]) {
    const modelsOfProvider = (byProvider.get(provider) || [])
      .slice()
      .sort((a, b) => (a.costPer1k || 0) - (b.costPer1k || 0));
    if (modelsOfProvider.length === 0) continue;
    const allFree = modelsOfProvider.every((m) => !m.costPer1k);
    groups.push({
      provider,
      label: providerLabel(provider),
      costLabel: allFree ? '免费' : '消耗积分',
      keys: modelsOfProvider.map((m) => m.key),
      defaultKey: modelsOfProvider[0].key,
    });
  }
  return groups;
}

// Find which group a model key belongs to, given the resolved groups.
export function groupForModel(key: string, groups: ModelGroup[]): ModelGroup | undefined {
  return groups.find((g) => g.keys.includes(key));
}

// 思考等级 (think-level) — mirrors the fast/standard/thinking rungs of
// MODE_MULTIPLIER in the billing engine. Mapped to existing chat modes.
export const THINK_LEVELS = [
  { key: 'fast', label: '快速' },
  { key: 'standard', label: '标准' },
  { key: 'thinking', label: '思考' },
] as const;

// Credits-per-1M-token display label for paid models (♦︎). costPer1k is
// credits per 1,000 tokens, so × 1000 → per 1M. Free models return ''.
export function modelCreditChip(costPer1k?: number): string {
  if (!costPer1k || costPer1k <= 0) return '';
  return `［${Math.round(costPer1k * 1000)}♦︎/1M token］`;
}

// ==================== Video model metadata ====================

export const VIDEO_MODELS = [
  {
    key: 'agnes-video-2.5-flash',
    displayName: 'Agnes Video 2.5 Flash',
    maxDurationSec: 12,
    fpsControlled: false,
    durations: [4, 5, 6, 8, 10, 12] as number[],
    ratios: [
      { label: '21:9', width: 1680, height: 720 },
      { label: '16:9', width: 1280, height: 704 },
      { label: '4:3',  width: 960,  height: 720 },
      { label: '1:1',  width: 720,  height: 720 },
      { label: '3:4',  width: 720,  height: 960 },
      { label: '9:16', width: 720,  height: 1280 },
    ],
  },
  {
    key: 'agnes-video-v2.0',
    displayName: 'Agnes Video v2.0',
    maxDurationSec: 441,
    fpsControlled: true,
    fpsRange: [1, 60] as [number, number],
    supportedDurations: [5, 10, 15, 18, 20] as number[],
    ratios: [
      { label: '16:9', width: 1152, height: 768 },
      { label: '9:16', width: 768,  height: 1152 },
      { label: '1:1',  width: 768,  height: 768 },
      { label: '4:3',  width: 1024, height: 768 },
      { label: '3:4',  width: 768,  height: 1024 },
    ],
  },
];

// ==================== Image model metadata ====================

export const IMAGE_MODELS = [
  {
    key: 'agnes-image-2.5-flash',
    displayName: 'Agnes Image 2.5 Flash',
    sizes: [
      { ratio: '1:1',   w1k: 1024,  h1k: 1024,  w2k: 2048,  h2k: 2048,  w3k: 3072,  h3k: 3072,  w4k: 4096,  h4k: 4096  },
      { ratio: '3:4',   w1k: 864,   h1k: 1152,  w2k: 1728,  h2k: 2304,  w3k: 2592,  h3k: 3456,  w4k: 3456,  h4k: 4608 },
      { ratio: '4:3',   w1k: 1152,  h1k: 864,   w2k: 2304,  h2k: 1728,  w3k: 3456,  h3k: 2592,  w4k: 4688,  h4k: 3456 },
      { ratio: '16:9',  w1k: 1312,  h1k: 736,   w2k: 2624,  h2k: 1472,  w3k: 3936,  h3k: 2208,  w4k: 5248,  h4k: 2944 },
      { ratio: '9:16',  w1k: 736,   h1k: 1312,  w2k: 1472,  h2k: 2624,  w3k: 2208,  h3k: 3936,  w4k: 2944,  h4k: 5248 },
      { ratio: '2:3',   w1k: 832,   h1k: 1248,  w2k: 1664,  h2k: 2496,  w3k: 2496,  h3k: 3744,  w4k: 3328,  h4k: 4992 },
      { ratio: '3:2',   w1k: 1248,  h1k: 832,   w2k: 2496,  h2k: 1664,  w3k: 3744,  h3k: 2496,  w4k: 4992,  h4k: 3328 },
      { ratio: '21:9',  w1k: 1568,  h1k: 672,   w2k: 3136,  h2k: 1344,  w3k: 4704,  h3k: 2016,  w4k: 6272,  h4k: 2688 },
    ],
  },
  {
    key: 'agnes-image-2.1-flash',
    displayName: 'Agnes Image 2.1 Flash',
    sizes: [
      { ratio: '1:1',   w1k: 1024,  h1k: 1024,  w2k: 2048,  h2k: 2048,  w3k: 3072,  h3k: 3072,  w4k: 4096,  h4k: 4096  },
      { ratio: '3:4',   w1k: 864,   h1k: 1152,  w2k: 1728,  h2k: 2304,  w3k: 2592,  h3k: 3456,  w4k: 3456,  h4k: 4608 },
      { ratio: '4:3',   w1k: 1152,  h1k: 864,   w2k: 2304,  h2k: 1728,  w3k: 3456,  h3k: 2592,  w4k: 4688,  h4k: 3456 },
      { ratio: '16:9',  w1k: 1312,  h1k: 736,   w2k: 2624,  h2k: 1472,  w3k: 3936,  h3k: 2208,  w4k: 5248,  h4k: 2944 },
      { ratio: '9:16',  w1k: 736,   h1k: 1312,  w2k: 1472,  h2k: 2624,  w3k: 2208,  h3k: 3936,  w4k: 2944,  h4k: 5248 },
      { ratio: '2:3',   w1k: 832,   h1k: 1248,  w2k: 1664,  h2k: 2496,  w3k: 2496,  h3k: 3744,  w4k: 3328,  h4k: 4992 },
      { ratio: '3:2',   w1k: 1248,  h1k: 832,   w2k: 2496,  h2k: 1664,  w3k: 3744,  h3k: 2496,  w4k: 4992,  h4k: 3328 },
      { ratio: '21:9',  w1k: 1568,  h1k: 672,   w2k: 3136,  h2k: 1344,  w3k: 4704,  h3k: 2016,  w4k: 6272,  h4k: 2688 },
    ],
  },
  {
    key: 'agnes-image-2.0-flash',
    displayName: 'Agnes Image 2.0 Flash',
    sizes: [
      { ratio: '1:1',   w1k: 1024,  h1k: 1024,  w2k: 2048,  h2k: 2048,  w3k: 3072,  h3k: 3072,  w4k: 4096,  h4k: 4096  },
      { ratio: '3:4',   w1k: 864,   h1k: 1152,  w2k: 1728,  h2k: 2304,  w3k: 2592,  h3k: 3456,  w4k: 3456,  h4k: 4608 },
      { ratio: '4:3',   w1k: 1152,  h1k: 864,   w2k: 2304,  h2k: 1728,  w3k: 3456,  h3k: 2592,  w4k: 4688,  h4k: 3456 },
      { ratio: '16:9',  w1k: 1312,  h1k: 736,   w2k: 2624,  h2k: 1472,  w3k: 3936,  h3k: 2208,  w4k: 5248,  h4k: 2944 },
      { ratio: '9:16',  w1k: 736,   h1k: 1312,  w2k: 1472,  h2k: 2624,  w3k: 2208,  h3k: 3936,  w4k: 2944,  h4k: 5248 },
      { ratio: '2:3',   w1k: 832,   h1k: 1248,  w2k: 1664,  h2k: 2496,  w3k: 2496,  h3k: 3744,  w4k: 3328,  h4k: 4992 },
      { ratio: '3:2',   w1k: 1248,  h1k: 832,   w2k: 2496,  h2k: 1664,  w3k: 3744,  h3k: 2496,  w4k: 4992,  h4k: 3328 },
      { ratio: '21:9',  w1k: 1568,  h1k: 672,   w2k: 3136,  h2k: 1344,  w3k: 4704,  h3k: 2016,  w4k: 6272,  h4k: 2688 },
    ],
  },
];
