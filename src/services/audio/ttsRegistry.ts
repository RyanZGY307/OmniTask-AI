// ================================================================
// TTS Capability Registry — single source of truth for the 5 audio
// generation models (Xiaomi MiMo + Gemini TTS). No model list or
// provider-name branching is duplicated across routes / adapters / UI.
//
// Capability relationships (spec):
//   - mimo-v2.5-tts: plain TTS + style/delivery instructions only.
//     Not Voice Design. No voice reference required.
//   - mimo-v2.5-tts-voiceclone: TTS + style + Voice Clone. Requires a
//     reference audio (uploaded via Context artifact reference).
//   - mimo-v2.5-tts-voicedesign: TTS + Voice Design. No reference audio.
//   - gemini-3.8-flash-tts / -lite-tts: TTS + Voice Design + Voice
//     Replication + style instruction.
//
// "Style Instruction" (delivery: 温柔/低沉/激动/slow) is a separate
// capability from "Voice Design" (creating a voice identity: 年轻、
// 温暖、有磁性的男声). Never conflate the two.
// ================================================================

export type TtsProvider = 'xiaomi' | 'gemini';

export type TtsFormat = 'wav' | 'mp3' | 'pcm' | 'pcm16' | 'mulaw' | 'alaw';

export interface TtsModelDef {
  modelId: string;
  provider: TtsProvider;
  displayName: string;
  generationCapability: 'audio';
  supportedFormats: TtsFormat[];
  supportsVoiceDesign: boolean;
  supportsVoiceClone: boolean;
  supportsStyleInstruction: boolean;
  defaultFormat: TtsFormat;
  defaultVoice: string | null;
  requiresVoiceReference: boolean;
  requestAdapter: string; // 'mimo' | 'gemini' — adapter module key
  responseAdapter: string; // 'mimo' | 'gemini' — response parser key
}

export const TTS_MODELS: TtsModelDef[] = [
  {
    modelId: 'mimo-v2.5-tts',
    provider: 'xiaomi',
    displayName: 'Xiaomi MiMo TTS',
    generationCapability: 'audio',
    supportedFormats: ['wav', 'mp3', 'pcm', 'pcm16'],
    supportsVoiceDesign: false,
    supportsVoiceClone: false,
    supportsStyleInstruction: true,
    defaultFormat: 'wav',
    defaultVoice: 'mimo_default',
    requiresVoiceReference: false,
    requestAdapter: 'mimo',
    responseAdapter: 'mimo',
  },
  {
    modelId: 'mimo-v2.5-tts-voiceclone',
    provider: 'xiaomi',
    displayName: 'Xiaomi MiMo TTS Voice Clone',
    generationCapability: 'audio',
    supportedFormats: ['wav', 'mp3', 'pcm', 'pcm16'],
    supportsVoiceDesign: false,
    supportsVoiceClone: true,
    supportsStyleInstruction: true,
    defaultFormat: 'wav',
    defaultVoice: null,
    requiresVoiceReference: true,
    requestAdapter: 'mimo',
    responseAdapter: 'mimo',
  },
  {
    modelId: 'mimo-v2.5-tts-voicedesign',
    provider: 'xiaomi',
    displayName: 'Xiaomi MiMo TTS Voice Design',
    generationCapability: 'audio',
    supportedFormats: ['wav', 'mp3', 'pcm', 'pcm16'],
    supportsVoiceDesign: true,
    supportsVoiceClone: false,
    supportsStyleInstruction: false,
    defaultFormat: 'wav',
    defaultVoice: null,
    requiresVoiceReference: false,
    requestAdapter: 'mimo',
    responseAdapter: 'mimo',
  },
  {
    modelId: 'gemini-3.8-flash-tts',
    provider: 'gemini',
    displayName: 'Gemini 3.8 Flash TTS',
    generationCapability: 'audio',
    supportedFormats: ['wav', 'pcm', 'mulaw', 'alaw'],
    supportsVoiceDesign: true,
    supportsVoiceClone: true,
    supportsStyleInstruction: true,
    defaultFormat: 'wav',
    defaultVoice: null,
    requiresVoiceReference: false,
    requestAdapter: 'gemini',
    responseAdapter: 'gemini',
  },
  {
    modelId: 'gemini-3.8-flash-lite-tts',
    provider: 'gemini',
    displayName: 'Gemini 3.8 Flash-Lite TTS',
    generationCapability: 'audio',
    supportedFormats: ['wav', 'pcm', 'mulaw', 'alaw'],
    supportsVoiceDesign: true,
    supportsVoiceClone: true,
    supportsStyleInstruction: true,
    defaultFormat: 'wav',
    defaultVoice: null,
    requiresVoiceReference: false,
    requestAdapter: 'gemini',
    responseAdapter: 'gemini',
  },
];

export const TTS_MODEL_MAP: Record<string, TtsModelDef> = Object.fromEntries(
  TTS_MODELS.map((m) => [m.modelId, m]),
);

export function getTtsModel(modelId: string): TtsModelDef | null {
  return TTS_MODEL_MAP[modelId] ?? null;
}

// Format validity: a (model, format) pair is legal only when the format
// is in that model's supportedFormats. Frontend enforces once, backend
// enforces again here (never trust the client).
export function isValidFormatForModel(modelId: string, format: TtsFormat): boolean {
  const model = getTtsModel(modelId);
  return !!model && model.supportedFormats.includes(format);
}

// When the user switches models, the selected format may become illegal.
// Return the format the UI/runtime should fall back to (the new model's
// default).
export function defaultFormatForModel(modelId: string): TtsFormat | null {
  return getTtsModel(modelId)?.defaultFormat ?? null;
}

// Provider-level format codes (for the provider request adapter):
// Xiaomi passes the lowercase format token through; Gemini maps to
// its MIME-ish audio encoding codes.
const GEMINI_FORMAT_CODES: Record<TtsFormat, string> = {
  wav: 'audio/wav',
  pcm: 'audio/l16',
  mulaw: 'audio/mulaw',
  alaw: 'audio/alaw',
  // Xiaomi-only formats have no Gemini mapping (unsupported by Gemini).
  mp3: '',
  pcm16: '',
};

export function geminiFormatCode(format: TtsFormat): string {
  return GEMINI_FORMAT_CODES[format] ?? '';
}

// MIME types for storage + playback routing.
const FORMAT_MIME: Record<TtsFormat, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  pcm: 'application/octet-stream',
  pcm16: 'application/octet-stream',
  mulaw: 'application/octet-stream',
  alaw: 'application/octet-stream',
};

export function mimeForFormat(format: TtsFormat): string {
  return FORMAT_MIME[format] ?? 'application/octet-stream';
}

// Raw encodings are NOT directly playable by browsers. A playback
// representation (WAV container / decoded+re-encoded) must be produced
// deterministically — never by an LLM.
export function needsPlaybackConversion(format: TtsFormat): boolean {
  return format === 'pcm' || format === 'pcm16' || format === 'mulaw' || format === 'alaw';
}
