// Audio intent gate tests — verify true generation requests open the
// card while discussion / analysis / reference / non-generative audio
// mentions do NOT. Run: npx tsx test/audioIntent.test.ts
import { analyzeAudioGenerationIntent } from '../src/services/audio/intent';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const gate = (m: string, history?: any[]) => analyzeAudioGenerationIntent({ message: m, history });

console.log('\n=== True generation requests (must open card) ===');
check('朗读：xxx → open', gate('朗读：你好，欢迎来到 OmniTask。').shouldOpenAudioCard === true);
check('朗读 auto-fills spokenText', gate('朗读：你好，欢迎来到 OmniTask。').autoFill?.spokenText === '你好，欢迎来到 CortexAI。');
check('用年轻温柔女声朗读 → open + voice + content', (() => {
  const r = gate('用年轻温柔女声朗读：今天是一个美好的开始。');
  return r.shouldOpenAudioCard === true && !!r.autoFill?.voiceDesign && r.autoFill?.spokenText === '今天是一个美好的开始。';
})());
check('生成纪录片男声介绍火星 → open + contentOverview (not transcript)', (() => {
  const r = gate('生成一个低沉的纪录片男声，介绍火星探测历史。');
  return r.shouldOpenAudioCard === true && !!r.autoFill?.contentOverview && r.autoFill?.contentOverview!.includes('火星');
})());
check('"用刚才上传的声音读下面这段" → open + voiceReferenceHint', (() => {
  const r = gate('用刚才上传的声音读：欢迎回来。', [{ role: 'user', content: '上传了 my_voice.wav' }]);
  return r.shouldOpenAudioCard === true && r.autoFill?.voiceReferenceHint === true;
})());

console.log('\n=== Non-generation audio mentions (must NOT open) ===');
check('"什么是 TTS？" → no card', gate('什么是 TTS？').shouldOpenAudioCard === false);
check('"Gemini TTS 和 MiMo TTS 有什么区别？" → no card', gate('Gemini TTS 和 MiMo TTS 有什么区别？').shouldOpenAudioCard === false);
check('"MiMo TTS 支持哪些格式？" → no card', gate('MiMo TTS 支持哪些格式？').shouldOpenAudioCard === false);
check('"帮我分析这个音频" → no card', gate('帮我分析这个音频').shouldOpenAudioCard === false);
check('"我最近在学习音频生成" → no card', gate('我最近在学习音频生成').shouldOpenAudioCard === false);

console.log('\n=== Auto-fill detail ===');
{
  const r = gate('用年轻、磁性的男声朗读：你好');
  check('voice extracted', !!r.autoFill?.voiceDesign && r.autoFill.voiceDesign!.includes('年轻'), `got ${JSON.stringify(r.autoFill)}`);
  check('content = 你好', r.autoFill?.spokenText === '你好');
}
{
  const r = gate('生成音频，而且我想直接在这里听。');
  check('bare audio gen opens card', r.shouldOpenAudioCard === true, JSON.stringify(r));
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
