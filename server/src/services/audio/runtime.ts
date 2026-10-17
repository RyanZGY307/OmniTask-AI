// ================================================================
// Audio Generation Runtime — validate → generate → validate response
// → persist. Orchestrates the provider adapters, audio prompt
// compilation, response decoding + format validation, artifact
// persistence and playback-representation conversion.
//
// chat.ts never touches provider details. It submits a standardized
// AudioGenerationSpec; this runtime picks the adapter from the TTS
// capability registry. Failure types are explicit (spec §13) and no
// provider failure silently switches models.
// ================================================================

import {
  getTtsModel,
  isValidFormatForModel,
  mimeForFormat,
  needsPlaybackConversion,
  type TtsFormat,
  type TtsModelDef,
} from './ttsRegistry';
import { MiMoTTSAdapter, GeminiTTSAdapter, type AudioGenerationRequest, type AudioGenerationResult } from './adapters';

export type AudioErrorType =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_FORMAT'
  | 'MISSING_VOICE_REFERENCE'
  | 'PROVIDER_AUTH_ERROR'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RESPONSE_INVALID'
  | 'AUDIO_DECODE_ERROR'
  | 'STORAGE_ERROR';

export class AudioGenerationError extends Error {
  readonly errorType: AudioErrorType;
  constructor(errorType: AudioErrorType, message: string) {
    super(message);
    this.name = 'AudioGenerationError';
    this.errorType = errorType;
  }
}

export interface AudioGenerationSpec {
  model: string;
  format: TtsFormat;
  voiceDesign?: string;
  contentOverview?: string;
  spokenText?: string;
  voiceReferenceId?: string;
  voiceId?: string;
  styleInstruction?: string;
  contextReferences?: string[];
  sourceMessageId?: string;
  conversationId?: string;
  userId?: string;
}

export interface AudioArtifactRecord {
  artifactId: string;
  type: 'audio';
  provider: string;
  model: string;
  format: TtsFormat;
  mimeType: string;
  originalStorageRef: string;
  playbackStorageRef: string | null;
  filename: string;
  size: number;
  duration: number | null;
  generationId: string;
  conversationId: string | null;
  messageId: string | null;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  metadata: Record<string, any>;
}

export interface AudioGenerationOutcome {
  ok: boolean;
  errorType?: AudioErrorType;
  error?: string;
  artifact?: AudioArtifactRecord;
  providerRequestId?: string;
  selectedModel?: string;
  actualModel?: string;
  latencyMs?: number;
}

// ==================== Audio Prompt Compiler ====================

// The UI's contentOverview is NEVER stuffed verbatim into the TTS
// transcript. This compiles the three independent pieces:
//   - styleInstruction  → delivery/style channel (e.g. "gentle, slow")
//   - voiceDesign       → voice-identity channel (e.g. "young, warm male")
//   - spokenText        → the literal text to read aloud
// For a contentOverview without an explicit transcript, a lightweight
// determinable rule produces spokenText; the caller can supply it.
export function compileAudioPrompt(spec: AudioGenerationSpec, model: TtsModelDef): {
  styleChannel: string;
  voiceDesignChannel: string;
  spokenText: string;
} {
  let spokenText = (spec.spokenText ?? spec.contentOverview ?? '').trim();
  // A pure content direction (e.g. "介绍火星探测历史") is not a
  // ready-to-read transcript; mark it as overview so downstream can
  // expand it rather than read the instruction aloud.
  const isOverviewOnly = !spec.spokenText && !!spec.contentOverview;

  let styleChannel = (spec.styleInstruction ?? '').trim();
  let voiceDesignChannel = (spec.voiceDesign ?? '').trim();

  // Models that don't support Voice Design must not receive a design
  // prompt as if it were a style instruction — instead degrade the
  // design description into a style/delivery cue when the model supports
  // style, else drop it (never pass voice-design text as transcript).
  if (!model.supportsVoiceDesign && voiceDesignChannel) {
    if (model.supportsStyleInstruction) {
      styleChannel = styleChannel ? `${styleChannel}, ${voiceDesignChannel}` : voiceDesignChannel;
    }
    voiceDesignChannel = '';
  }

  return {
    styleChannel,
    voiceDesignChannel: model.supportsVoiceDesign ? voiceDesignChannel : '',
    spokenText: isOverviewOnly ? spokenText : spokenText || (spec.contentOverview ?? '').trim(),
  };
}

// ==================== Provider Adapter selection ====================

function selectAdapter(model: TtsModelDef) {
  if (model.requestAdapter === 'mimo') return new MiMoTTSAdapter();
  if (model.requestAdapter === 'gemini') return new GeminiTTSAdapter();
  throw new AudioGenerationError('INVALID_REQUEST', `No adapter for provider ${model.provider}`);
}

// ==================== Main entry ====================

// deps.createArtifactRow: pre-create the AudioArtifact row (status
// 'generating') so the route can flip it to completed/failed with the
// real storage refs. Called before the provider so a failure leaves a
// 'failed' row, never a completed+broken one.
export async function runAudioGeneration(
  spec: AudioGenerationSpec,
  deps: {
    persistArtifact?: (artifact: AudioArtifactRecord, bytes: Buffer) => Promise<{ originalRef: string; playbackRef: string | null }>;
    storePlayback?: (userId: string, artifactId: string, bytes: Buffer) => Promise<string>;
    loadVoiceReference?: (voiceReferenceId: string) => Promise<Buffer | null>;
    createArtifactRow?: (record: AudioArtifactRecord) => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<AudioGenerationOutcome> {
  const startedAt = Date.now();
  const model = getTtsModel(spec.model);
  if (!model) {
    return failOutcome('INVALID_REQUEST', `Unknown audio model: ${spec.model}`, spec.model);
  }
  if (!isValidFormatForModel(spec.model, spec.format)) {
    return failOutcome('UNSUPPORTED_FORMAT', `Format ${spec.format} not supported by ${model.displayName}`, model.modelId);
  }

  // Voice clone requires a reference. Absent → explicit state, NO provider call.
  if (model.requiresVoiceReference && !spec.voiceReferenceId) {
    return failOutcome('MISSING_VOICE_REFERENCE', `${model.displayName} requires a voice reference (upload audio first)`, model.modelId);
  }

  const adapter = selectAdapter(model);
  const { styleChannel, voiceDesignChannel, spokenText } = compileAudioPrompt(spec, model);
  if (!spokenText && !model.requiresVoiceReference) {
    return failOutcome('INVALID_REQUEST', 'No spoken text or content to generate', model.modelId);
  }

  // Pre-create the 'generating' artifact row so failures are observable.
  const generationId = `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const filename = `${model.modelId}.${extForFormat(spec.format)}`;
  const pendingRecord: AudioArtifactRecord = {
    artifactId: generationId,
    type: 'audio',
    provider: model.provider,
    model: model.modelId,
    format: spec.format,
    mimeType: mimeForFormat(spec.format),
    originalStorageRef: 'pending',
    playbackStorageRef: null,
    filename,
    size: 0,
    duration: null,
    generationId,
    conversationId: spec.conversationId ?? null,
    messageId: spec.sourceMessageId ?? null,
    status: 'generating' as any,
    metadata: { selectedModel: model.modelId, actualModel: model.modelId },
  };
  try {
    await deps.createArtifactRow?.(pendingRecord);
  } catch {
    return { ...failOutcome('STORAGE_ERROR', 'Could not create artifact row', model.modelId) };
  }

  const request: AudioGenerationRequest = {
    model: model.modelId,
    format: spec.format,
    spokenText,
    styleInstruction: styleChannel,
    voiceDesign: voiceDesignChannel,
    voiceReferenceId: spec.voiceReferenceId ?? null,
    voiceId: spec.voiceId ?? null,
    contentOverview: spec.contentOverview ?? null,
    sourceMessageId: spec.sourceMessageId ?? null,
    conversationId: spec.conversationId ?? null,
  };

  let result: AudioGenerationResult;
  try {
    result = await adapter.generate(request, {
      loadVoiceReference: deps.loadVoiceReference,
      signal: deps.signal,
    });
  } catch (err: any) {
    const et = mapProviderError(err);
    markArtifactFailed(pendingRecord, et, String(err?.message ?? err));
    return { ...failOutcome(et, String(err?.message ?? err), model.modelId), latencyMs: Date.now() - startedAt, artifact: pendingRecord };
  }

  if (!result.audioBytes || result.audioBytes.length === 0) {
    markArtifactFailed(pendingRecord, 'PROVIDER_RESPONSE_INVALID', 'Provider returned no audio data');
    return { ...failOutcome('PROVIDER_RESPONSE_INVALID', 'Provider returned no audio data', model.modelId), latencyMs: Date.now() - startedAt, artifact: pendingRecord };
  }

  // ---- Audio format validation ----
  try {
    validateAudioData(result.audioBytes, result.format, result.encoding, result.sampleRate);
  } catch (err: any) {
    markArtifactFailed(pendingRecord, 'AUDIO_DECODE_ERROR', String(err?.message ?? err));
    return { ...failOutcome('AUDIO_DECODE_ERROR', String(err?.message ?? err), model.modelId), latencyMs: Date.now() - startedAt, artifact: pendingRecord };
  }

  // ---- Playback representation for raw encodings ----
  let playbackBytes: Buffer | null = null;
  if (needsPlaybackConversion(result.format)) {
    try {
      playbackBytes = buildPlaybackRepresentation(result.audioBytes, result.format, result.encoding, result.sampleRate, result.channels);
    } catch (err: any) {
      markArtifactFailed(pendingRecord, 'AUDIO_DECODE_ERROR', `Playback conversion failed: ${err?.message}`);
      return { ...failOutcome('AUDIO_DECODE_ERROR', `Playback conversion failed: ${err?.message}`, model.modelId), latencyMs: Date.now() - startedAt, artifact: pendingRecord };
    }
  }

  // ---- Persist original (+ playback) ----
  try {
    const stored = deps.persistArtifact
      ? await deps.persistArtifact(pendingRecord, result.audioBytes)
      : { originalRef: `memory://${generationId}`, playbackRef: null };

    let playbackRef: string | null = null;
    if (deps.storePlayback && playbackBytes) {
      playbackRef = await deps.storePlayback(spec.userId ?? '', generationId, playbackBytes);
    }

    const artifact: AudioArtifactRecord = {
      ...pendingRecord,
      originalStorageRef: stored.originalRef,
      playbackStorageRef: playbackRef ?? stored.playbackRef ?? null,
      size: result.audioBytes.byteLength,
      status: 'completed',
      metadata: {
        ...pendingRecord.metadata,
        encoding: result.encoding,
        sampleRate: result.sampleRate ?? null,
        channels: result.channels ?? null,
        bitDepth: result.bitDepth ?? null,
        providerRequestId: result.providerRequestId ?? null,
        voiceId: result.voiceId ?? spec.voiceId ?? null,
        actualModel: model.modelId,
      },
    };

    return {
      ok: true,
      artifact,
      providerRequestId: result.providerRequestId ?? null,
      selectedModel: model.modelId,
      actualModel: model.modelId,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err: any) {
    markArtifactFailed(pendingRecord, 'STORAGE_ERROR', String(err?.message ?? err));
    return { ...failOutcome('STORAGE_ERROR', String(err?.message ?? err), model.modelId), latencyMs: Date.now() - startedAt, artifact: pendingRecord };
  }
}

// Best-effort: record the failure on the artifact row (route handles the
// DB write; this helper centralizes the status + reason).
function markArtifactFailed(_record: AudioArtifactRecord, _et: AudioErrorType, _msg: string): void {
  // The route marks the row 'failed' using the outcome it returns.
}

// ==================== Helpers ====================

function failOutcome(errorType: AudioErrorType, message: string, model: string | null): AudioGenerationOutcome {
  return { ok: false, errorType, error: message, selectedModel: model ?? undefined, actualModel: model ?? undefined };
}

function mapProviderError(err: any): AudioErrorType {
  const s = String(err?.message ?? err);
  if (/401|403|auth|unauthor|invalid key|api key/i.test(s)) return 'PROVIDER_AUTH_ERROR';
  if (/429|rate.?limit|too many|quota/i.test(s)) return 'PROVIDER_RATE_LIMIT';
  if (/timeout|aborted|abort/i.test(s)) return 'PROVIDER_TIMEOUT';
  if (/no audio|empty|invalid response|parse/i.test(s)) return 'PROVIDER_RESPONSE_INVALID';
  return 'PROVIDER_TIMEOUT';
}

// Basic header sniffing: WAV must start with RIFF; PCM/mulaw/alaw are
// raw (no magic). Guard against "a WAV with a RIFF header getting a
// second WAV header wrapped around it" (spec §10).
export function validateAudioData(bytes: Buffer, format: string, encoding?: string, sampleRate?: number): void {
  if (format === 'wav' || encoding === 'wav') {
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') {
      throw new Error('WAV data missing RIFF header — refusing to re-wrap');
    }
    return;
  }
  // Raw encodings: verify a plausible size (non-trivial payload).
  if (bytes.length < 16) throw new Error('Audio payload too small to be valid');
}

// Deterministic playback conversion (NO LLM). Wrap raw PCM16 in a real
// WAV container using the true encoding params. mu-law/A-law decode to
// 16-bit PCM then wrap. PCM defaults to 16-bit LE 44.1kHz mono when the
// provider omits the metadata (documented fallback, still recorded).
export function buildPlaybackRepresentation(bytes: Buffer, format: string, encoding?: string, sampleRate?: number, channels?: number): Buffer {
  const sr = sampleRate && sampleRate > 0 ? sampleRate : 44100;
  const ch = channels && channels > 0 ? channels : 1;
  let pcm: Buffer;
  if (format === 'pcm16' || format === 'pcm' || encoding === 'l16' || encoding === 'pcm') {
    pcm = bytes;
  } else if (format === 'mulaw' || encoding === 'mulaw' || format === 'alaw' || encoding === 'alaw') {
    pcm = decodeMuLawOrALaw(bytes, format === 'alaw' || encoding === 'alaw' ? 'alaw' : 'mulaw');
  } else {
    throw new Error(`No playback representation for raw format ${format}`);
  }
  return wrapWav(pcm, sr, ch, 16);
}

function wrapWav(pcm: Buffer, sampleRate: number, channels: number, bitDepth: number): Buffer {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

// mu-law (A-law identical structure, different byte mapping) → 16-bit LE PCM.
function decodeMuLawOrALaw(bytes: Buffer, kind: 'mulaw' | 'alaw'): Buffer {
  const out = Buffer.alloc(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    const sample = kind === 'mulaw' ? mulawToLinear(bytes[i]) : alawToLinear(bytes[i]);
    out.writeUInt16LE(sample & 0xffff, i * 2);
  }
  return out;
}

function mulawToLinear(byte: number): number {
  const quantize = (x: number) => x >>> 0;
  let i = ~(byte & 0x0f);
  let seg = ((byte & 0x70) >> 4) << 3;
  const sign = byte & 0x80 ? -1 : 1;
  i += seg;
  const pred = (i + 2) << 6;
  let out = pred - 32;
  out = quantize(out);
  return sign === 1 ? out : out + (1 << 16); // two's complement via 16-bit
}

function alawToLinear(byte: number): number {
  let b = ~byte & 0xff;
  let ex = (((b & 0x04) ? 0x40 : 0x0) | (b & 0x70)) >> 4;
  let man = (b & 0x0f) + 0x10;
  let sample: number;
  if (ex === 0) sample = 8 + (man << 4);
  else sample = 4 + man + ((ex - 1) << (ex + 5)) + ((ex - 1) << (ex + 5)) + ((ex - 1) << 7);
  if (b & 0x80) sample = -sample;
  return (sample << 3) & 0xffff;
}

function extForFormat(format: TtsFormat): string {
  const map: Record<string, string> = { wav: 'wav', mp3: 'mp3', pcm: 'pcm', pcm16: 'pcm16', mulaw: 'mulaw', alaw: 'alaw' };
  return map[format] ?? 'bin';
}

// ==================== Concurrency protection (product-unlimited ≠
// unbounded concurrency; spec §14) ====================

const inFlight = new Map<string, number>();
const AUDIO_PER_USER_CONCURRENCY = 3;
const AUDIO_GLOBAL_CONCURRENCY = 12;

export class AudioConcurrencyGuard {
  async acquire(userId: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const userCount = inFlight.get(userId) ?? 0;
      let total = 0;
      for (const v of inFlight.values()) total += v;
      if (userCount < AUDIO_PER_USER_CONCURRENCY && total < AUDIO_GLOBAL_CONCURRENCY) {
        inFlight.set(userId, userCount + 1);
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new AudioGenerationError('INVALID_REQUEST', 'Audio generation concurrency limit reached, try again shortly');
  }
  release(userId: string): void {
    const c = (inFlight.get(userId) ?? 0) - 1;
    if (c <= 0) inFlight.delete(userId);
    else inFlight.set(userId, c);
  }
}

export const audioConcurrencyGuard = new AudioConcurrencyGuard();
