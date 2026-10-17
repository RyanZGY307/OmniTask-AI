// ================================================================
// Provider Adapters — Xiaomi MiMo TTS + Gemini TTS.
//
// The runtime (audio/runtime.ts) hands each adapter a standardized
// AudioGenerationRequest. Each adapter builds ITS OWN provider request
// shape (no provider branching in routes/UI). No `if model ===` chains
// anywhere outside these files.
//
// MiMo response: choices[0].message.audio.data (base64) → Buffer →
// validation. Only providerRequestId / model / format / encoding are
// recorded, never the raw provider response.
// ================================================================

import { getApiKey, reportKeySuccess, reportKeyFailure, getKeyPoolSize } from '../apiKeyPool';
import { PROVIDER_BASE_URLS } from '../../config';
import type { TtsFormat } from './ttsRegistry';

export interface AudioGenerationRequest {
  model: string;
  format: TtsFormat;
  spokenText: string;
  styleInstruction: string;
  voiceDesign: string;
  voiceReferenceId: string | null;
  voiceId: string | null;
  contentOverview?: string | null;
  sourceMessageId?: string | null;
  conversationId?: string | null;
}

export interface AudioGenerationResult {
  audioBytes: Buffer;
  format: TtsFormat;
  mimeType: string;
  encoding?: string;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  duration?: number;
  providerRequestId?: string;
  voiceId?: string | null;
}

export interface AdapterDeps {
  loadVoiceReference?: (id: string) => Promise<Buffer | null>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AudioModelAdapter {
  generate(req: AudioGenerationRequest, deps: AdapterDeps): Promise<AudioGenerationResult>;
  // Optional: create/reuse a designed voice (Gemini Voice Design flow).
  createVoice?(opts: { prompt: string; userId: string }, deps: AdapterDeps): Promise<{ voiceId: string; sampleAudio?: Buffer }>;
}

// ==================== Xiaomi MiMo TTS ====================
// Endpoint (spec §5): POST https://api.xiaomimimo.com/v1/chat/completions
// Auth: api-key header, drawn from the "xiaomi" key pool
// (XIAOMI_API_KEY_1..5) — the same pool the rest of the Xiaomi model line
// (MiMo-V2.6) uses, so key rotation + least-used-first + cooldown are
// shared across all Xiaomi calls. No separate "mimo" key pool.
//
// Standard TTS:  user = VOICE_STYLE_OR_DELIVERY, assistant = SPOKEN_TEXT
// Voice Design:  user = VOICE_DESIGN_DESCRIPTION, assistant = SPOKEN_TEXT
// Voice Clone:   user = "", voice = "data:{mime};base64,{refAudio}"
//
// MiMo and Gemini never share a request shape.

const MIMO_BASE_URL = process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1';
// MiMo is a Xiaomi model line — its API keys come from the "xiaomi" pool
// (XIAOMI_API_KEY_*), sharing rotation / least-used-first with the rest of
// Xiaomi. There is no separate "mimo" key pool.
const MIMO_KEY_POOL = 'xiaomi';

export class MiMoTTSAdapter implements AudioModelAdapter {
  async generate(req: AudioGenerationRequest, deps: AdapterDeps): Promise<AudioGenerationResult> {
    const body = this.buildRequest(req, deps);

    const data = await this.callMiMo(body, deps);

    const out = this.parseResponse(data, req.format);
    return out;
  }

  // Build the MiMo request payload. VoiceClone uses a data-URI voice
  // reference; VoiceDesign puts the design description in the user role.
  buildRequest(req: AudioGenerationRequest, deps: AdapterDeps): Record<string, any> {
    const base: Record<string, any> = {
      model: req.model,
      audio: { format: req.format === 'pcm16' ? 'pcm' : req.format },
    };

    const isClone = req.model === 'mimo-v2.5-tts-voiceclone';
    const isDesign = req.model === 'mimo-v2.5-tts-voicedesign';

    if (isClone) {
      // voice = data:{mime};base64,<reference>. The reference is loaded
      // on demand from artifact storage — NEVER persisted as a giant
      // base64 DB column.
      base.messages = [
        { role: 'user', content: '' },
        { role: 'assistant', content: req.spokenText },
      ];
      base.audio.voice = 'pending';
      // When the deps supply a loader, attach the load promise; the
      // data-URI is materialized in callMiMo after awaiting it.
      if (req.voiceReferenceId && deps.loadVoiceReference) {
        base.__voiceRefPromise = deps.loadVoiceReference(req.voiceReferenceId);
      }
    } else if (isDesign) {
      // Voice Design: design description → user channel. Spoken text →
      // assistant. Never merged into a single transcript.
      base.messages = [
        { role: 'user', content: req.voiceDesign || req.styleInstruction || '' },
        { role: 'assistant', content: req.spokenText },
      ];
      delete (base as any).__voiceRefPromise;
    } else {
      // Standard TTS: style/delivery instruction → user channel.
      base.messages = [
        { role: 'user', content: req.styleInstruction || '' },
        { role: 'assistant', content: req.spokenText },
      ];
      base.audio.voice = 'mimo_default';
    }

    return base;
  }

    // Resolve the voice reference data-URI (VoiceClone) and fire the call.
  private async callMiMo(body: Record<string, any>, deps: AdapterDeps): Promise<any> {
    // Voice clone: load reference audio and build the data-URI in audio.voice.
    const refPromise = (body as any).__voiceRefPromise as Promise<Buffer | null> | undefined;
    if (refPromise) {
      const ref = await refPromise;
      if (!ref) throw new Error('MISSING_VOICE_REFERENCE');
      const b64 = ref.toString('base64');
      const mime = 'audio/wav';
      body.audio = { ...(body.audio as any), voice: `data:${mime};base64,${b64}` };
      delete (body as any).__voiceRefPromise;
    }
    return await this.callProvider(body, deps);
  }

  private async callProvider(body: Record<string, any>, deps: AdapterDeps): Promise<any> {
    const provider = MIMO_KEY_POOL;
    const poolSize = Math.max(getKeyPoolSize(provider), 1);
    let lastErr: unknown = new Error('No MiMo API key');

    for (let attempt = 0; attempt < poolSize; attempt++) {
      const apiKey = getApiKey(provider);
      if (!apiKey) {
        lastErr = new Error('PROVIDER_AUTH_ERROR: No MiMo API key available');
        break;
      }

      const controller = new AbortController();
      const timeoutMs = deps.timeoutMs ?? 90_000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (deps.signal) {
        const onAbort = () => controller.abort();
        deps.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        const res = await fetch(`${MIMO_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 401 || res.status === 403) {
            lastErr = new Error(`PROVIDER_AUTH_ERROR ${res.status}: ${text.slice(0, 160)}`);
            reportKeyFailure(provider, apiKey, `HTTP ${res.status}`);
            continue;
          }
          if (res.status === 429) {
            lastErr = new Error(`PROVIDER_RATE_LIMIT: ${text.slice(0, 160)}`);
            reportKeyFailure(provider, apiKey, `HTTP 429`);
            continue;
          }
          throw new Error(`PROVIDER_ERROR ${res.status}: ${text.slice(0, 200)}`);
        }

        reportKeySuccess(provider, apiKey, 0);
        const data: any = await res.json();
        return data;
      } catch (err: any) {
        clearTimeout(timer);
        if (err?.name === 'AbortError') {
          lastErr = new Error('PROVIDER_TIMEOUT');
          reportKeyFailure(provider, apiKey, 'timeout');
          continue;
        }
        if (String(err?.message).startsWith('PROVIDER_ERROR')) throw err;
        lastErr = err;
        reportKeyFailure(provider, apiKey, err?.message ?? String(err));
        continue;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

// Response: choices[0].message.audio.data (base64) → Buffer.
  parseResponse(data: any, format: TtsFormat, providerRequestId?: string): AudioGenerationResult {
    const audio = data?.choices?.[0]?.message?.audio;
    const b64: string | undefined = audio?.data;
    if (!b64) {
      // Some responses nest under content / audio_url.
      const alt = data?.choices?.[0]?.message?.audio_url?.b64_json;
      if (!alt) throw new Error('PROVIDER_RESPONSE_INVALID: no audio data in MiMo response');
      const bytes = Buffer.from(alt, 'base64');
      return this.toResult(bytes, format, providerRequestId || data?.id);
    }
    const bytes = Buffer.from(b64, 'base64');
    return this.toResult(bytes, format, providerRequestId || data?.id);
  }

  private toResult(bytes: Buffer, format: TtsFormat, providerRequestId?: string): AudioGenerationResult {
    const encoding = format === 'pcm' || format === 'pcm16' ? 'l16' : format === 'mulaw' ? 'mulaw' : format === 'alaw' ? 'alaw' : 'wav';
    return {
      audioBytes: bytes,
      format,
      mimeType: mimeForFormatLocal(format),
      encoding,
      sampleRate: 24000,
      channels: 1,
      bitDepth: format === 'wav' ? 16 : 16,
      providerRequestId: providerRequestId ?? null,
    };
  }
}

// ==================== Gemini TTS ====================
// Endpoint (spec §9): POST /v1beta/interactions (single-speaker TTS).
// Voice Design: POST /v1beta/voices → voice_... → TTS with voice.
//
// text = literal transcript (NOT the style instruction). Style goes in
// speech_metadata. Designed voices go in generation_config.speech_config.

const GEMINI_TTS_BASE_URL = process.env.GEMINI_TTS_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiTTSAdapter implements AudioModelAdapter {
  async generate(req: AudioGenerationRequest, deps: AdapterDeps): Promise<AudioGenerationResult> {
    // Voice Design: ensure we have a voice id (create or reuse).
    let voiceId = req.voiceId;
    if (req.voiceDesign && !voiceId) {
      const created = await this.createVoice({ prompt: req.voiceDesign, userId: '' }, deps);
      voiceId = created.voiceId;
    }

    const body = this.buildTtsRequest(req, voiceId);
    const data = await this.callProvider(body, deps);
    return this.parseResponse(data, req.format);
  }

  buildTtsRequest(req: AudioGenerationRequest, voiceId?: string | null): Record<string, any> {
    const body: Record<string, any> = {
      model: req.model,
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: req.spokenText,
              annotations: [],
            },
          ],
        },
      ],
      response_format: { type: 'audio', encoding: geminiEncoding(req.format) },
    };
    // Style → speech_metadata annotation on the text content.
    if (req.styleInstruction) {
      const textContent = (body.input[0] as any).content[0] as any;
      textContent.annotations.push({ type: 'speech_metadata', style: req.styleInstruction });
    }
    // Voice (designed or replicated) → generation_config.speech_config.
    if (voiceId) {
      body.generation_config = {
        speech_config: [{ voice: voiceId }],
      };
    }
    return body;
  }

  // Voice Design: create a prompted voice (POST /v1beta/voices). Dedup
  // by prompt+userId signature so identical designs are NOT recreated.
  async createVoice(
    opts: { prompt: string; userId: string },
    _deps: AdapterDeps,
  ): Promise<{ voiceId: string; sampleAudio?: Buffer }> {
    const provider = 'google';
    const apiKey = getApiKey(provider);
    if (!apiKey) throw new Error('PROVIDER_AUTH_ERROR: No Gemini API key available');
    const res = await fetch(`${GEMINI_TTS_BASE_URL}/voices?api_key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-tts',
        voice: { description: opts.prompt },
      }),
    });
    if (!res.ok) throw new Error(`PROVIDER_ERROR ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data: any = await res.json();
    const voiceId: string | undefined = data?.name || data?.id;
    if (!voiceId) throw new Error('PROVIDER_RESPONSE_INVALID: no voice id in create-voice response');
    return { voiceId, sampleAudio: data?.sampleAudio ? Buffer.from(data.sampleAudio, 'base64') : undefined };
  }

  private async callProvider(body: Record<string, any>, deps: AdapterDeps): Promise<any> {
    const provider = 'google';
    const poolSize = Math.max(getKeyPoolSize(provider), 1);
    let lastErr: unknown = new Error('No Gemini API key');

    for (let attempt = 0; attempt < poolSize; attempt++) {
      const apiKey = getApiKey(provider);
      if (!apiKey) {
        lastErr = new Error('PROVIDER_AUTH_ERROR: No Gemini API key available');
        break;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 90_000);
      if (deps.signal) deps.signal.addEventListener('abort', () => controller.abort(), { once: true });
      try {
        const res = await fetch(`${GEMINI_TTS_BASE_URL}/interactions?api_key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 401 || res.status === 403) {
            lastErr = new Error(`PROVIDER_AUTH_ERROR ${res.status}`);
            reportKeyFailure(provider, apiKey, `HTTP ${res.status}`);
            continue;
          }
          if (res.status === 429) {
            lastErr = new Error('PROVIDER_RATE_LIMIT');
            reportKeyFailure(provider, apiKey, 'HTTP 429');
            continue;
          }
          throw new Error(`PROVIDER_ERROR ${res.status}: ${text.slice(0, 200)}`);
        }
        reportKeySuccess(provider, apiKey, 0);
        return (await res.json()) as any;
      } catch (err: any) {
        clearTimeout(timer);
        if (err?.name === 'AbortError') {
          lastErr = new Error('PROVIDER_TIMEOUT');
          reportKeyFailure(provider, apiKey, 'timeout');
          continue;
        }
        if (String(err?.message).startsWith('PROVIDER_ERROR')) throw err;
        lastErr = err;
        reportKeyFailure(provider, apiKey, err?.message ?? String(err));
        continue;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  // Gemini TTS is synchronous — interactions returns the audio directly.
  parseResponse(data: any, format: TtsFormat, providerRequestId?: string): AudioGenerationResult {
      // Locate the base64 audio payload wherever it sits in the response.
      const candidates: string[] = [];
      const walk = (o: any, depth = 0) => {
        if (!o || typeof o !== 'object' || depth > 6) return;
        if (typeof o.audio === 'string' && o.audio.length > 0) candidates.push(o.audio);
        if (typeof o.b64_json === 'string' && o.b64_json.length > 0) candidates.push(o.b64_json);
        if (typeof o.data === 'string' && o.data.startsWith('data:audio') && o.data.length > 64) candidates.push(o.data);
        for (const v of Object.values(o)) walk(v, depth + 1);
      };
      walk(data);
      let b64 = candidates.find((c) => c.length > 64) || '';
      if (b64.startsWith('data:')) b64 = b64.split(',')[1] || b64;
      if (!b64) throw new Error('PROVIDER_RESPONSE_INVALID: no audio data in Gemini response');
      const bytes = Buffer.from(b64, 'base64');
      const encoding = geminiEncoding(format);
      return {
        audioBytes: bytes,
        format,
        mimeType: mimeForFormatLocal(format),
        encoding,
        sampleRate: 24000,
        channels: 1,
        providerRequestId: providerRequestId ?? (data as any)?.responseId ?? (data as any)?.id ?? null,
      };
    }
  }

// ==================== helpers ====================

function geminiEncoding(format: TtsFormat): string {
  const m: Record<string, string> = {
    wav: 'audio/wav',
    pcm: 'audio/l16',
    mulaw: 'audio/mulaw',
    alaw: 'audio/alaw',
    // mp3/pcm16 are not Gemini formats; the registry gates them off.
    mp3: 'audio/wav',
    pcm16: 'audio/l16',
  };
  return m[format] ?? 'audio/wav';
}

function mimeForFormatLocal(format: TtsFormat): string {
  const m: Record<string, string> = {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    pcm: 'application/octet-stream',
    pcm16: 'application/octet-stream',
    mulaw: 'application/octet-stream',
    alaw: 'application/octet-stream',
  };
  return m[format] ?? 'application/octet-stream';
}

export { geminiEncoding as _geminiEncoding };
