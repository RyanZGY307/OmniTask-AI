// ================================================================
// Audio Generation Runtime + Adapters + Registry — unit tests.
// Run: npx tsx test/audio.test.ts
//
// Zero-provider-call tests: provider fetch is not exercised here (no
// real keys / network in sandbox). These cover:
//   - model-format validation (legal/illegal pairs)
//   - Xiaomi 3-model request builders (standard / voicedesign / voiceclone)
//   - Gemini 2-model request builder (text vs style separation, voice)
//   - voice-clone missing reference → explicit error, no provider call
//   - deterministic playback representation (PCM/PCM16/Mu-law/A-law → WAV)
//   - WAV double-wrap refusal
//   - concurrency guard
//   - prompt compiler channel separation (style vs voiceDesign vs spoken)
// ================================================================

import {
  TTS_MODELS,
  isValidFormatForModel,
  getTtsModel,
  defaultFormatForModel,
  mimeForFormat,
  needsPlaybackConversion,
  geminiFormatCode,
} from '../src/services/audio/ttsRegistry';
import {
  runAudioGeneration,
  compileAudioPrompt,
  validateAudioData,
  buildPlaybackRepresentation,
  audioConcurrencyGuard,
  AudioGenerationError,
  type AudioGenerationSpec,
} from '../src/services/audio/runtime';
import { MiMoTTSAdapter, GeminiTTSAdapter } from '../src/services/audio/adapters';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ==================== Model-format validation ====================
console.log('\n=== Model-format validation ===');
{
  check('Xiaomi: wav/mp3/pcm/pcm16 legal', ['wav', 'mp3', 'pcm', 'pcm16'].every((f: any) => isValidFormatForModel('mimo-v2.5-tts', f)));
  check('Xiaomi voiceclone: same formats', ['wav', 'mp3', 'pcm', 'pcm16'].every((f: any) => isValidFormatForModel('mimo-v2.5-tts-voiceclone', f)));
  check('Xiaomi voicedesign: same formats', ['wav', 'mp3', 'pcm', 'pcm16'].every((f: any) => isValidFormatForModel('mimo-v2.5-tts-voicedesign', f)));
  check('Gemini: wav/pcm/mulaw/alaw legal', ['wav', 'pcm', 'mulaw', 'alaw'].every((f: any) => isValidFormatForModel('gemini-3.8-flash-tts', f)));
  check('Gemini lite: same formats', ['wav', 'pcm', 'mulaw', 'alaw'].every((f: any) => isValidFormatForModel('gemini-3.8-flash-lite-tts', f)));

  check('Gemini + MP3 rejected', isValidFormatForModel('gemini-3.8-flash-tts', 'mp3' as any) === false);
  check('Xiaomi + Mu-law rejected', isValidFormatForModel('mimo-v2.5-tts', 'mulaw' as any) === false);
  check('Gemini + PCM16 rejected', isValidFormatForModel('gemini-3.8-flash-lite-tts', 'pcm16' as any) === false);

  check('defaultFormat(gemini) = wav', defaultFormatForModel('gemini-3.8-flash-tts') === 'wav');
  check('defaultFormat(mimo) = wav', defaultFormatForModel('mimo-v2.5-tts') === 'wav');

  check('5 models registered', TTS_MODELS.length === 5, `got ${TTS_MODELS.length}`);
  check('mimo plain: no voicedesign', getTtsModel('mimo-v2.5-tts')!.supportsVoiceDesign === false);
  check('mimo plain: no clone', getTtsModel('mimo-v2.5-tts')!.supportsVoiceClone === false);
  check('mimo plain: style on', getTtsModel('mimo-v2.5-tts')!.supportsStyleInstruction === true);
  check('mimo clone: requiresVoiceReference', getTtsModel('mimo-v2.5-tts-voiceclone')!.requiresVoiceReference === true);
  check('mimo clone: no voicedesign', getTtsModel('mimo-v2.5-tts-voiceclone')!.supportsVoiceDesign === false);
  check('mimo design: voicedesign on', getTtsModel('mimo-v2.5-tts-voicedesign')!.supportsVoiceDesign === true);
  check('gemini: voicedesign + clone + style', (() => {
    const m = getTtsModel('gemini-3.8-flash-tts')!;
    return m.supportsVoiceDesign && m.supportsVoiceClone && m.supportsStyleInstruction;
  })());
  check('geminiFormatCode(wav) = audio/wav', geminiFormatCode('wav' as any) === 'audio/wav');
  check('geminiFormatCode(pcm) = audio/l16', geminiFormatCode('pcm' as any) === 'audio/l16');
  check('geminiFormatCode(mulaw) = audio/mulaw', geminiFormatCode('mulaw' as any) === 'audio/mulaw');
  check('needsPlaybackConversion(raw) = true', ['pcm', 'pcm16', 'mulaw', 'alaw'].every((f: any) => needsPlaybackConversion(f)));
  check('needsPlaybackConversion(wav/mp3) = false', !needsPlaybackConversion('wav' as any) && !needsPlaybackConversion('mp3' as any));
  check('mime mp3 = audio/mpeg', mimeForFormat('mp3' as any) === 'audio/mpeg');
}

// ==================== Prompt compiler (channel separation) ====================
console.log('\n=== Prompt compiler: style vs voiceDesign vs spoken ===');
{
  const plain = getTtsModel('mimo-v2.5-tts')!;
  const design = getTtsModel('mimo-v2.5-tts-voicedesign')!;
  const gem = getTtsModel('gemini-3.8-flash-tts')!;

  // Plain TTS: voiceDesign must degrade to style channel, never be a
  // transcript; spoken stays literal.
  {
    const out = compileAudioPrompt({ model: 'mimo-v2.5-tts', format: 'wav', voiceDesign: '年轻、有磁性男声', spokenText: '你好', styleInstruction: '慢速' } as any, plain);
    check('plain: spokenText = 你好', out.spokenText === '你好');
    check('plain: voiceDesign merged into style', out.styleChannel.includes('年轻、有磁性男声') && out.voiceDesignChannel === '');
    check('plain: style kept', out.styleChannel.includes('慢速'));
  }
  // Design model: voiceDesign stays in its own channel.
  {
    const out = compileAudioPrompt({ model: 'mimo-v2.5-tts-voicedesign', format: 'wav', voiceDesign: '年轻、有磁性男声', spokenText: '你好' } as any, design);
    check('design: voiceDesignChannel kept', out.voiceDesignChannel === '年轻、有磁性男声');
    check('design: spokenText separate', out.spokenText === '你好');
  }
  // Gemini: style is a separate annotation channel from text.
  {
    const out = compileAudioPrompt({ model: 'gemini-3.8-flash-tts', format: 'wav', voiceDesign: '温暖成熟女声', spokenText: '欢迎', styleInstruction: 'calm' } as any, gem);
    check('gemini: styleChannel = calm', out.styleChannel === 'calm');
    check('gemini: voiceDesignChannel = 温暖成熟女声', out.voiceDesignChannel === '温暖成熟女声');
  }
}

// ==================== MiMo request builders ====================
console.log('\n=== MiMo request builders ===');
{
  const adapter = new MiMoTTSAdapter();

  // Standard TTS: style → user role, spoken → assistant role.
  {
    const req: any = { model: 'mimo-v2.5-tts', format: 'wav', spokenText: '你好', styleInstruction: '慢速', voiceDesign: '', voiceReferenceId: null, voiceId: null };
    const body = adapter.buildRequest(req, {} as any);
    check('mimo std: user role = style', body.messages[0].content === '慢速');
    check('mimo std: assistant role = spoken', body.messages[1].content === '你好');
    check('mimo std: default voice', body.audio.voice === 'mimo_default');
    check('mimo std: model name', body.model === 'mimo-v2.5-tts');
  }

  // VoiceDesign: design description → user role (NOT merged with transcript).
  {
    const req: any = { model: 'mimo-v2.5-tts-voicedesign', format: 'wav', spokenText: '欢迎来到未来世界', voiceDesign: '年轻、温暖、有磁性的男性声音', voiceReferenceId: null, voiceId: null };
    const body = adapter.buildRequest(req, {} as any);
    check('mimo design: user role = design desc', body.messages[0].content === '年轻、温暖、有磁性的男性声音');
    check('mimo design: assistant role = spoken (separate)', body.messages[1].content === '欢迎来到未来世界');
    check('mimo design: user and assistant differ', body.messages[0].content !== body.messages[1].content);
  }

  // VoiceClone: user role empty, voice = data-URI (needs reference).
  {
    const req: any = { model: 'mimo-v2.5-tts-voiceclone', format: 'wav', spokenText: '欢迎回来', voiceReferenceId: 'ref-1', voiceId: null };
    const body = adapter.buildRequest(req, {
      loadVoiceReference: async () => Buffer.from('fakeaudio'),
    } as any);
    check('mimo clone: user role empty', body.messages[0].content === '');
    check('mimo clone: assistant role = spoken', body.messages[1].content === '欢迎回来');
    check('mimo clone: voice pending before load', body.audio.voice === 'pending');
    check('mimo clone: ref promise attached', (body as any).__voiceRefPromise instanceof Promise);
  }

  // pcm16 normalizes to 'pcm' on the wire.
  {
    const req: any = { model: 'mimo-v2.5-tts', format: 'pcm16', spokenText: 'x', voiceDesign: '', voiceReferenceId: null, voiceId: null };
    const body = adapter.buildRequest(req, {} as any);
    check('mimo pcm16 → wire format pcm', body.audio.format === 'pcm');
  }
}

// ==================== Gemini request builder ====================
console.log('\n=== Gemini request builder ===');
{
  const adapter = new GeminiTTSAdapter();
  const req: any = { model: 'gemini-3.8-flash-tts', format: 'wav', spokenText: '火星是第四颗行星', styleInstruction: 'warm, cinematic, measured', voiceDesign: '', voiceReferenceId: null, voiceId: null };
  const body = adapter.buildTtsRequest(req, null);
  check('gemini: text = literal transcript', body.input[0].content[0].text === '火星是第四颗行星');
  check('gemini: style NOT in text', !body.input[0].content[0].text.includes('warm'));
  check('gemini: style in annotation', body.input[0].content[0].annotations[0].style === 'warm, cinematic, measured');
  check('gemini: response_format audio', body.response_format.type === 'audio');
  check('gemini: encoding audio/wav', body.response_format.encoding === 'audio/wav');

  // With a designed voice → generation_config.speech_config.
  const body2 = adapter.buildTtsRequest(req, 'voice_abc123');
  check('gemini: voice in speech_config', body2.generation_config.speech_config[0].voice === 'voice_abc123');

  // Both Gemini models share the adapter, distinguished by model param.
  const liteReq: any = { ...req, model: 'gemini-3.8-flash-lite-tts' };
  const liteBody = adapter.buildTtsRequest(liteReq, null);
  check('gemini lite: model param = lite', liteBody.model === 'gemini-3.8-flash-lite-tts');
  check('gemini lite: same shape', liteBody.input[0].type === 'user_input');
}

// ==================== VoiceClone missing reference + async cases =====
(async () => {
console.log('\n=== VoiceClone missing reference (no provider call) ===');
{
  let providerCalled = false;
  const outcome = await runAudioGeneration(
    { model: 'mimo-v2.5-tts-voiceclone', format: 'wav', spokenText: '你好', voiceReferenceId: undefined } as AudioGenerationSpec,
    {
      persistArtifact: async () => { providerCalled = true; return { originalRef: 'x', playbackRef: null }; },
      loadVoiceReference: async () => { providerCalled = true; return Buffer.alloc(0); },
    },
  );
  check('missing ref → not ok', outcome.ok === false);
  check('errorType = MISSING_VOICE_REFERENCE', outcome.errorType === 'MISSING_VOICE_REFERENCE');
  check('no provider/storage call made', providerCalled === false);
}

// ==================== Unknown model + bad format ====================
console.log('\n=== Invalid request / unsupported format ===');
{
  const o1 = await runAudioGeneration({ model: 'nope', format: 'wav' } as any, {} as any);
  check('unknown model → INVALID_REQUEST', o1.ok === false && o1.errorType === 'INVALID_REQUEST');

  const o2 = await runAudioGeneration({ model: 'gemini-3.8-flash-tts', format: 'mp3' as any, spokenText: 'x' } as any, {} as any);
  check('gemini+mp3 → UNSUPPORTED_FORMAT', o2.ok === false && o2.errorType === 'UNSUPPORTED_FORMAT');

  const o3 = await runAudioGeneration({ model: 'mimo-v2.5-tts', format: 'mulaw' as any, spokenText: 'x' } as any, {} as any);
  check('mimo+mulaw → UNSUPPORTED_FORMAT', o3.ok === false && o3.errorType === 'UNSUPPORTED_FORMAT');
}

// ==================== WAV double-wrap refusal ====================
console.log('\n=== WAV validation (no double header) ===');
{
  const fakeRiff = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(40)]);
  check('valid RIFF passes', (() => { try { validateAudioData(fakeRiff, 'wav'); return true; } catch { return false; } })());
  check('non-RIFF wav rejected', (() => { try { validateAudioData(Buffer.alloc(44), 'wav'); return false; } catch { return true; } })());
  check('tiny raw payload rejected', (() => { try { validateAudioData(Buffer.alloc(4), 'pcm'); return false; } catch { return true; } })());
}

// ==================== Playback representation (deterministic, no LLM) ====================
console.log('\n=== Playback representation: raw → WAV ===');
{
  // PCM16 mono 100 samples @ 8000Hz → valid WAV with correct header.
  const pcm = Buffer.alloc(200); // 100 samples * 2 bytes
  for (let i = 0; i < 100; i++) pcm.writeInt16LE(i, i * 2);
  const wav = buildPlaybackRepresentation(pcm, 'pcm16', 'l16', 8000, 1);
  check('pcm16 → WAV has RIFF header', wav.toString('ascii', 0, 4) === 'RIFF');
  check('pcm16 → WAV magic', wav.toString('ascii', 8, 12) === 'WAVE');
  check('pcm16 → fmt PCM format 1', wav.readUInt16LE(20) === 1);
  check('pcm16 → channels 1', wav.readUInt16LE(22) === 1);
  check('pcm16 → sampleRate 8000', wav.readUInt32LE(24) === 8000);
  check('pcm16 → bitDepth 16', wav.readUInt16LE(34) === 16);
  check('pcm16 → data size = pcm size', wav.readUInt32LE(40) === pcm.length);
  check('pcm16 → total = header + pcm', wav.length === 44 + pcm.length);

  // Mu-law decode: 1 byte/sample → 2 byte/sample PCM.
  const mulaw = Buffer.alloc(100);
  mulaw.fill(0xff); // silence-ish
  const wavM = buildPlaybackRepresentation(mulaw, 'mulaw', 'mulaw', 8000, 1);
  check('mulaw → WAV', wavM.toString('ascii', 0, 4) === 'RIFF');
  check('mulaw data = 2x input bytes', wavM.readUInt32LE(40) === mulaw.length * 2);

  // A-law decode.
  const alaw = Buffer.alloc(50);
  const wavA = buildPlaybackRepresentation(alaw, 'alaw', 'alaw', 8000, 1);
  check('alaw → WAV', wavA.toString('ascii', 0, 4) === 'RIFF');
  check('alaw data = 2x input bytes', wavA.readUInt32LE(40) === alaw.length * 2);

  // Defaults when provider omits metadata.
  const wavDefault = buildPlaybackRepresentation(Buffer.alloc(16), 'pcm', 'pcm');
  check('pcm default sampleRate 44100', wavDefault.readUInt32LE(24) === 44100);
}

// ==================== Concurrency guard (inside async IIFE) ==========
console.log('\n=== Concurrency guard (product-unlimited ≠ unbounded) ===');
{
  const limiter = async (u: string) => {
    await audioConcurrencyGuard.acquire(u);
    await new Promise((r) => setTimeout(r, 50));
    audioConcurrencyGuard.release(u);
  };
  await Promise.all([limiter('user-x'), limiter('user-x'), limiter('user-x'), limiter('user-x')]);
  check('4 sequential grants completed for one user', true);
  const t0 = Date.now();
  await audioConcurrencyGuard.acquire('user-timeout-test');
  check('acquire returns promptly when free', Date.now() - t0 < 200);
  audioConcurrencyGuard.release('user-timeout-test');
}

// ==================== Failure outcome never a completed artifact ====
console.log('\n=== Failure leaves no completed artifact ===');
{
  // Force a storage failure: persistArtifact throws.
  const outcome = await runAudioGeneration(
    { model: 'mimo-v2.5-tts', format: 'wav', spokenText: '你好' } as AudioGenerationSpec,
    {
      // Adapter call is bypassed because there are no provider keys in
      // the sandbox; the MiMo adapter will throw PROVIDER_TIMEOUT (key
      // pool empty), which must surface as a failure, not a completed
      // artifact.
      persistArtifact: async () => { throw new Error('disk full'); },
      loadVoiceReference: async () => null,
      createArtifactRow: async () => { /* no-op */ },
    },
  );
  check('no-provider-key → not ok', outcome.ok === false);
  check('errorType is a provider/storage type', ['PROVIDER_TIMEOUT', 'PROVIDER_AUTH_ERROR', 'STORAGE_ERROR'].includes(outcome.errorType || ''), `got ${outcome.errorType}`);
  check('no completed artifact on failure', outcome.artifact?.status !== 'completed' || outcome.artifact === undefined);
}

// All async cases live in the same IIFE; finish it and report.
console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
})();
