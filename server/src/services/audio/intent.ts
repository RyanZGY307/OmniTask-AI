// ================================================================
// Audio Intent Gate — distinguishes "user wants to GENERATE audio"
// from the 4 near-miss cases (discussing audio / analyzing audio /
// modifying existing audio / referencing existing audio).
//
// Reuses the deterministic extractEvents capability detection (no new
// AI call). A bare audio keyword ("什么是 TTS？", "MiMo 支持哪些格式？")
// must NOT open the spec card. Only a generation verb + audio object
// (or a "用…声音朗读…" / "帮我生成/做一个…声音…" request) triggers.
// ================================================================

import { extractEvents } from '../contextMemory/extract';

export interface AudioGateInput {
  message: string;
  history?: Array<{ role: string; content: string; messageId?: string }>;
}

export interface AudioGateResult {
  shouldOpenAudioCard: boolean;
  reason: 'generate_audio' | 'not_generation' | 'general';
  autoFill?: {
    contentOverview?: string;
    spokenText?: string;
    voiceDesign?: string;
    styleInstruction?: string;
    voiceReferenceHint?: boolean;
  };
}

// Strong generation-verb phrases that unambiguously ask for audio
// OUTPUT (as opposed to discussing / analyzing / modifying).
const GENERATION_VERB_RE = /(?:生成|做出|做一个|做一段|来一段|创建|合成|配音|念出|produce|generate|create|make|synth|read\s+aloud|read\s+this)\s*(?:一段|一个|份|张|部|个|成)?\s*(?:音频|语音|音乐|旁白|人声|声音|sound|audio|music|voice|narration)|(?:生成|做出|做|来|创建|想要|我需要|帮我)\s*(?:一个|一段|份|部)?\s*(?:.{1,20}?)\s*(?:声音|音色|声线|配音|旁白|音轨|audio|voice)|(?:文档|纪录片|新闻|电台|科技|频道).*?(?:男声|女声|配音|旁白)|朗读\s*[:：]|朗读\s*(?:下面|以下)?\s*(?:的|这段|这段话)?\s*(?:.{1,30}?[。！!]?|$)|生成\s*[:：]\s*(?:一段|一个|份)?\s*(?:音频|语音|旁白|音乐)/i;

// "读 / 念 / 说" immediately before a transcript — a generation cue
// that does NOT require the literal word "朗读".
const READ_VERB_RE = /(?:用.{0,20}?(?:读|念|说)\s*[:：]|(?:读|念)\s*[:：])|(?:帮我.{0,10}(?:读|念))|(?:把.{0,20}(?:读|念))\s*[:：]/i;

// Negative cases that must NOT open the card:
const NEGATIVE_RE = /(?:什么是|是什么|区别|对比|比较|支持哪些|怎么用|怎么工作|原理|解读|学习|讨论|播放这个|播放刚才|把.{0,10}音频.{0,10}换成|把.{0,10}音频.{0,10}改|改为.{0,10}格式)/i;

// "用刚才那个声音 / 用这个声音" — voice-clone reference signal.
const VOICE_REF_RE = /(?:用(?:刚才|刚才那个|之前那个|这个|该|此|已上传的)?\s*(?:那个|这个)?\s*(?:声音|音色|语音|voice))|(?:用刚才.{0,6}声音)|(?:my voice|my voice\.)|(?:上传.{0,10}声音)/i;

// Style/delivery cue ("慢速", "温柔地", "激动地") → styleInstruction.
const STYLE_CUE_RE = /(?:慢速|慢一点|快一点|温柔|低沉|激动|平静|缓慢|快速|slow|gentle|loud|calm|excited|measured|warm|deep)/i;

// Voice-design identity ("年轻、有磁性的男声" etc.) → voiceDesign when
// the model supports it, else merged into styleInstruction. Matches a
// voice-identity descriptor phrase, possibly followed by "…声".
const VOICE_DESIGN_RE = /(?:男声|女声|童声|音色|声线|磁性|纪录片|科技频道|documentary|narrator)|(?:年轻|成熟|温暖|温柔|低沉|高亢|磁性|清澈|沙哑|沉稳|清亮|柔和|明亮)\s*(?:的|、|,| )?\s*(?:男|女|童)?\s*声/i;

// Spoken transcript signal — an actual text to read aloud.
const SPOKEN_RE = /[:：]\s*(?![\u4e00-\u9fa5]*(?:生成|做|来|用))/; // "：xxx" / "： xxx"
const COLON_SPLIT_RE = /[:：]\s*(.+)/;

export function analyzeAudioGenerationIntent(input: AudioGateInput): AudioGateResult {
  const msg = input.message;

  // Explicit negative → never open the card.
  if (NEGATIVE_RE.test(msg)) {
    return { shouldOpenAudioCard: false, reason: 'not_generation' };
  }

  // Must have a generation verb + audio object, OR a "朗读：xxx" colon
  // transcript pattern, OR "用…声音读…" voice-clone + read request.
  const hasVerb = GENERATION_VERB_RE.test(msg) || READ_VERB_RE.test(msg);
  const hasColonTranscript = /[:：]\s*[\u4e00-\u9fa5A-Za-z0-9]/.test(msg) && /朗读|读|说|念|读出来/.test(msg);
  const hasVoiceRef = VOICE_REF_RE.test(msg);

  const shouldOpen = hasVerb || hasColonTranscript || (hasVoiceRef && /朗读|读|说|念/.test(msg));
  if (!shouldOpen) {
    // No generation intent. extractEvents can still flag capability
    // (audio_generation) for reference / context only — but the card
    // does NOT auto-open for "discuss / analyze / modify / reference".
    const extraction = extractEvents({ message: msg, messageId: 'gate', recentHistory: input.history ?? [] });
    if (extraction.capability === 'audio_generation' && (hasVerb || hasColonTranscript || hasVoiceRef)) {
      return { shouldOpenAudioCard: true, reason: 'generate_audio', autoFill: autoFill(msg, extraction, true) };
    }
    return { shouldOpenAudioCard: false, reason: 'general' };
  }

  // True generation request → open the card + auto-fill.
  const extraction = extractEvents({ message: msg, messageId: 'gate', recentHistory: input.history ?? [], conversationArtifacts: [] });
  return { shouldOpenAudioCard: true, reason: 'generate_audio', autoFill: autoFill(msg, extraction, true) };
}

function autoFill(
  msg: string,
  extraction: { capability: string | null; correction: any },
  isGeneration: boolean,
): AudioGateResult['autoFill'] {
  const out: AudioGateResult['autoFill'] = {};
  if (!isGeneration) return out;

  // 1) Transcript after a colon ("朗读：xxx" / "生成旁白：xxx")
  const colon = msg.match(COLON_SPLIT_RE);
  if (colon && /朗读|读|说|念|旁白|内容|文字|台词/.test(msg.slice(0, colon.index ?? 0))) {
    out.spokenText = colon[1].trim().slice(0, 2000);
  }

  // 2) Voice-design identity (if present) — keep even when the default
  // model has no Voice Design (it degrades to styleInstruction).
  if (VOICE_DESIGN_RE.test(msg) && !out.spokenText) {
    out.voiceDesign = extractVoiceDesign(msg);
  }
  // Even when a transcript is present, a concurrent voice-design
  // identity can co-exist ("用年轻女声，慢速朗读：xxx").
  if (VOICE_DESIGN_RE.test(msg) && out.spokenText) {
    out.voiceDesign = extractVoiceDesign(msg);
  }

  // 3) Style/delivery cue ("慢速", "温柔")
  if (STYLE_CUE_RE.test(msg)) {
    out.styleInstruction = extractStyle(msg);
  }

  // 4) Content overview: if no spoken transcript, the content noun
  // (e.g. "介绍火星探测历史的纪录片旁白") becomes contentOverview.
  if (!out.spokenText) {
    const overview = extractContentOverview(msg);
    if (overview) out.contentOverview = overview;
  }

  // 5) Voice reference signal ("用刚才那个声音")
  if (VOICE_REF_RE.test(msg)) {
    out.voiceReferenceHint = true;
  }

  return out;
}

// Pull the voice-identity fragment out of the message (what "kind of
// voice", not what to say). Capture the leading "用 X 声…" or "做一个
// X 声…" descriptor; fall back to a trimmed head of the message.
function extractVoiceDesign(msg: string): string {
  // "用年轻、温柔、有磁性的男声朗读：…" → "年轻、温柔、有磁性的男声"
  const mUse = msg.match(/用\s*([一-龥,，、]{2,30}?)(?:声|音色)?\s*(?:朗读|读|念|说|配音)?\s*[:：]/i);
  if (mUse) {
    let v = mUse[1].trim();
    if (!/(声|音色)/.test(v)) v += '声';
    return v;
  }
  // "做一个年轻男声版本" / "生成一个低沉的纪录片男声"
  const mGen = msg.match(/(?:做|生成|来|创建|想要|我需要)\s*(?:一个|一段|份|种)?\s*([一-龥,，、]{2,30}?)(?:声音|音色|声线|男声|女声|声|版本)/i);
  if (mGen) return mGen[1].trim();
  // Bare "年轻男声" style fragment.
  const mBare = msg.match(/([一-龥,，、]{2,24}?)(?:男声|女声|童声|声音|音色|声线)/i);
  if (mBare) return mBare[1].trim();
  return '';
}

// Pull delivery/style cues out of the message.
function extractStyle(msg: string): string {
  const cues: string[] = [];
  if (/慢速|慢一点|slow/i.test(msg)) cues.push('慢速');
  if (/快一点|快速|fast/i.test(msg)) cues.push('快速');
  if (/温柔|gentle/i.test(msg)) cues.push('温柔');
  if (/低沉|low/i.test(msg)) cues.push('低沉');
  if (/激动|excited/i.test(msg)) cues.push('激动');
  if (/平静|calm/i.test(msg)) cues.push('平静');
  if (/温暖|warm/i.test(msg)) cues.push('温暖');
  if (/磁性|warm/i.test(msg)) cues.push('有磁性');
  return cues.join(', ');
}

// Pull the content-topic phrase out of the message — used as
// contentOverview when no explicit transcript was given. Three shapes:
//   "生成一段介绍火星探测历史的纪录片旁白" → 介绍火星探测历史
//   "生成一个低沉的纪录片男声，介绍火星探测历史" → 介绍火星探测历史
//   "做一个纪录片男声" (no topic) → (falls back to whole msg head)
function extractContentOverview(msg: string): string {
  // Shape A: "生成/做 … X 的旁白/配音"
  const a = msg.match(/(?:生成|做|来|创建)\s*(?:一段|一个|份|部)?\s*(.{2,40}?)(?:旁白|语音|音频|配音|music|audio|narration)/i);
  if (a && a[1] && !voiceWordOnly(a[1])) return a[1].trim();
  // Shape B: "…男声/女声，介绍X" — topic after the voice descriptor.
  const b = msg.match(/(?:声|音色|voice)[，,]\s*(.{2,40})/i);
  if (b && b[1] && !voiceWordOnly(b[1])) return b[1].trim();
  // Shape C: comma-separated topic after the generation verb.
  const c = msg.match(/(?:生成|做|来|创建)\s*(?:一个|一段|份|部)?[^，,]{0,30}?[，,]\s*(.{2,40})/i);
  if (c && c[1] && !voiceWordOnly(c[1])) return c[1].trim();
  return '';
}

// A "content" that is itself just a voice descriptor is not a topic.
function voiceWordOnly(s: string): boolean {
  return /^(?:低沉|年轻|成熟|温暖|温柔|磁性|清澈|沙哑|沉稳|清亮|柔和|纪录片|科技|新闻|电台|高亢|明亮|男声|女声|童声|声音|音色|的)+$/i.test(s.trim());
}

export function isPureAudioDiscussion(msg: string): boolean {
  return NEGATIVE_RE.test(msg);
}
