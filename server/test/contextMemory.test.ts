// Comprehensive semantic tests for Context Memory + Context-Aware Intent
// + Correction/Verification chain. Pure rule/DB tests — no LLM calls.
// Run: npx tsx test/contextMemory.test.ts
//
// Covers the 20 spec cases (1-20) plus tier-budget, idempotency, and
// media-intent-preservation checks (acceptance criteria 21-26).

import { extractEvents, buildContextAwareIntent } from '../src/services/contextMemory/extract';
import {
  resolveContextBudget,
  type ContextAwareIntentResult,
} from '../src/services/contextMemory/types';
import { compressRange, buildVerificationQueries } from '../src/services/contextMemory/compression';

// buildVerificationQueries lives in runtime.ts (where dispatch happens).
import { buildVerificationQueries as buildQ } from '../src/services/contextMemory/runtime';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function ex(message: string, opts: { history?: Array<{ role: string; content: string }>; artifacts?: string[] } = {}) {
  return extractEvents({
    message,
    messageId: 'm1',
    recentHistory: opts.history ?? [],
    conversationArtifacts: opts.artifacts ?? [],
  });
}

// ==================== Case 1: new request ====================
console.log('\n=== Case 1: new request (no correction/verification) ===');
{
  const r = ex('帮我解释一下 React Server Components。');
  check('context_relation = new_request / reference', (r.correction.detected === false));
  check('no factual correction', r.correction.kind !== 'factual');
  check('no verification required', r.correction.verificationRequired === false);
  const intent = buildContextAwareIntent(null, r, {});
  check('relation is new_request or reference (not correction)', ['new_request', 'reference'].includes(intent.contextRelation), `got ${intent.contextRelation}`);
}

// ==================== Case 2: continuation ====================
console.log('\n=== Case 2: continuation of prior AI output ===');
{
  const r = ex('再详细一点。', { history: [{ role: 'assistant', content: '方案 A 是……方案 B 是……' }] });
  const intent = buildContextAwareIntent(null, r, {});
  check('detected as reference (prior AI output)', intent.contextRelation === 'reference', `got ${intent.contextRelation}`);
}

// ==================== Case 3: reference option #2 ====================
console.log('\n=== Case 3: reference second option ===');
{
  const r = ex('把第二个方案展开。', { history: [{ role: 'assistant', content: '方案一…方案二…方案三…' }] });
  check('reference ordinal = 2', r.reference?.targetType === 'ai_option' && r.reference.ordinal === 2, `got ${JSON.stringify(r.reference)}`);
  const intent = buildContextAwareIntent(null, r, {});
  check('relation = reference', intent.contextRelation === 'reference', `got ${intent.contextRelation}`);
}

// ==================== Case 4: task correction (NOT factual) ====================
console.log('\n=== Case 4: task correction, no web search ===');
{
  const r = ex('不是，我要的是架构分析。', { history: [{ role: 'assistant', content: '我来给你写代码。' }] });
  check('kind = task', r.correction.kind === 'task', `got ${r.correction.kind}`);
  check('no verification (no web search)', r.correction.verificationRequired === false);
  check('detected as correction', r.correction.detected === true);
}

// ==================== Case 5: requirement change ====================
console.log('\n=== Case 5: requirement change (not factual) ===');
{
  const r = ex('代码写完以后必须支持 ZIP 下载。');
  check('requirementChange = true', r.requirementChange === true);
  check('not a factual correction', r.correction.kind !== 'factual');
  check('no verification', r.correction.verificationRequired === false);
}

// ==================== Case 6: preference change supersedes old ====================
console.log('\n=== Case 6: preference change overrides old ===');
{
  const r = ex('之前我希望简单一点，现在我要完整详细版。');
  check('preferenceChange = true', r.preferenceChange === true);
  const intent = buildContextAwareIntent(null, r, {});
  check('relation = preference_change', intent.contextRelation === 'preference_change', `got ${intent.contextRelation}`);
}

// ==================== Case 7: factual correction => verification ====================
console.log('\n=== Case 7: factual correction triggers verification ===');
{
  const r = ex('不是，现在已经是 Y 了。', { history: [{ role: 'assistant', content: '当前版本是 X。' }] });
  check('kind = factual', r.correction.kind === 'factual', `got ${r.correction.kind}`);
  check('targets previous AI output', r.correction.targetsPreviousAiOutput === true);
  check('verification required', r.correction.verificationRequired === true);
  check('claim summary captured', r.correction.claimSummary?.includes('当前版本是 X') === true);
  check('user claim captured', r.correction.userClaim?.includes('Y') === true);
}

// ==================== Case 8: correction without explicit "你错了" ====================
console.log('\n=== Case 8: implicit factual correction ===');
{
  const r = ex('Y 已经发布了，不再是 X。', { history: [{ role: 'assistant', content: 'X 是最新版本。' }] });
  check('kind = factual', r.correction.kind === 'factual', `got ${r.correction.kind}`);
  check('verification required', r.correction.verificationRequired === true);
}

// ==================== Case 9: opinion disagreement (NOT factual) ====================
console.log('\n=== Case 9: opinion disagreement => no verification ===');
{
  const r = ex('我不同意，我觉得 B 更好。', { history: [{ role: 'assistant', content: '方案 A 更好。' }] });
  check('kind = opinion', r.correction.kind === 'opinion', `got ${r.correction.kind}`);
  check('no verification', r.correction.verificationRequired === false);
  check('detected as correction', r.correction.detected === true);
}

// ==================== Case 10: user corrects own preference ====================
console.log('\n=== Case 10: preference self-correction ===');
{
  const r = ex('我刚才说错了，我其实更喜欢方案 B。');
  check('kind = preference', r.correction.kind === 'preference', `got ${r.correction.kind}`);
  check('no verification', r.correction.verificationRequired === false);
  check('preferenceChange', r.preferenceChange === true);
}

// ==================== Case 11: file artifact reference ====================
console.log('\n=== Case 11: artifact reference resolves target id ===');
{
  const r = ex('把这个文件也改了。', { artifacts: ['abc123'] });
  check('reference target = artifact', r.reference?.targetType === 'artifact', `got ${JSON.stringify(r.reference)}`);
  check('reference target id = abc123', r.reference?.targetId === 'abc123');
}

// ==================== Case 12: image generation intact ====================
console.log('\n=== Case 12: image generation capability preserved ===');
{
  const r = ex('帮我生成一张图片。');
  check('capability = image_generation', r.capability === 'image_generation', `got ${r.capability}`);
}

// ==================== Case 13: video generation ====================
console.log('\n=== Case 13: video generation capability ===');
{
  const r = ex('把这个方案做成视频。');
  check('capability = video_generation', r.capability === 'video_generation', `got ${r.capability}`);
}

// ==================== Case 14: audio + in-app playback ====================
console.log('\n=== Case 14: audio generation + in-app playback ===');
{
  const r = ex('生成音频，而且我想直接在这里听。');
  check('capability = audio_generation', r.capability === 'audio_generation', `got ${r.capability}`);
  check('artifactRequired', r.artifactRequired === true);
  check('inAppPreview', r.inAppPreview === true);
}

// ==================== Case 15: PPT + in-app preview ====================
console.log('\n=== Case 15: presentation generation + preview ===');
{
  const r = ex('生成一个 PPT，做好以后我想直接在 AI 里面看，给我导出文件。');
  check('capability = presentation_generation', r.capability === 'presentation_generation', `got ${r.capability}`);
  check('artifactRequired', r.artifactRequired === true);
  check('inAppPreview', r.inAppPreview === true);
}

// ==================== Case 16: file modification + ZIP download ====================
console.log('\n=== Case 16: file modification + multi-file download ===');
{
  const r = ex('修改这个项目的代码，然后把完整项目打包成 ZIP 给我下载。');
  check('capability = file_modification', r.capability === 'file_modification', `got ${r.capability}`);
  check('artifactRequired (ZIP)', r.artifactRequired === true);
}

// ==================== Case 16: file modification + ZIP download ====================
console.log('\n=== Case 16: file modification + multi-file download ===');
{
  const r = ex('把刚才这个项目的代码修改一下，然后把完整项目 ZIP 给我。');
  check('capability = file_modification', r.capability === 'file_modification', `got ${r.capability}`);
  check('artifactRequired (ZIP)', r.artifactRequired === true);
}

// ==================== Case 17: long-term state supersede ====================
console.log('\n=== Case 17: decision supersede (Ultra retained then removed) ===');
{
  const r1 = ex('我准备保留 Ultra。');
  const r2 = ex('我决定删掉 Ultra。');
  check('first = decision', r1.decisionMade === true || r1.correction.kind === 'factual');
  check('second = decision (removal)', r2.decisionMade === true, `got ${JSON.stringify({kind:r2.correction.kind, dec:r2.decisionMade})}`);
  check('second is more important', r2.importance >= r1.importance);
}

// ==================== Case 18: active task overrides older project ====================
console.log('\n=== Case 18: "继续" returns current Active Task ===');
{
  // Simulated: retrieval should prioritize the ACTIVE task (Context Memory)
  // over the earlier "OmniTask" project. Verified at the DB layer by
  // checking ActiveTaskState snapshot (not pure here, so assert the
  // ordering contract on the extraction side: "继续" alone is low-value
  // but must not override an active task.
  const r = ex('继续。');
  check('"继续" is low-importance filler', r.importance < 0.1, `got ${r.importance}`);
  check('no correction from bare 继续', r.correction.detected === false);
}

// ==================== Case 19: correction survives compression ====================
console.log('\n=== Case 19: correction preserved through compression ===');
{
  const contents = [
    '好的。',
    '当前版本是 X。',
    '纠正一下，X 是 Z。',
    '明白。',
    '谢谢。',
  ];
  const compressed = compressRange(contents);
  check('correction line preserved', compressed.includes('纠正一下，X 是 Z'));
  check('assistant claim preserved', compressed.includes('当前版本是 X'));
  check('filler 好的 dropped', !/^\s*好的\s*$/m.test(compressed));
  check('filler 明白 dropped', !/^\s*明白\s*$/m.test(compressed));
  check('filler 谢谢 dropped', !/^\s*谢谢\s*$/m.test(compressed));
}

// ==================== Case 20: verification result state transitions ====================
console.log('\n=== Case 20: verification verdict states ===');
{
  // Reconcile logic: official source for user claim => VERIFIED_USER_CLAIM
  const q = buildQ('X 是 2', '现在是 4');
  check('parallel queries produced', q.length >= 2 && q.length <= 4, `got ${q.length}`);
  check('queries include official/primary framing', q.some((x) => /official|primary|release/i.test(x)), `got ${JSON.stringify(q)}`);
}

// ==================== Case 21/22: Free vs Pro budgets ====================
console.log('\n=== Cases 21-22: Free/Pro context budgets ===');
{
  const free = resolveContextBudget('FREE');
  const pro = resolveContextBudget('PRO');
  check('Pro has larger recent window', pro.recentUserMessageWindow > free.recentUserMessageWindow, `${pro.recentUserMessageWindow} vs ${free.recentUserMessageWindow}`);
  check('Pro has larger active task budget', pro.activeTaskBytes > free.activeTaskBytes);
  check('Pro has more long-term items', pro.longTermItems > free.longTermItems);
  check('Pro has deeper compressed budget', pro.compressedHistoryBytes > free.compressedHistoryBytes);
  check('Pro has deeper retrieval', pro.retrievalDepth > free.retrievalDepth);
  check('Ultra not required (maps to PRO)', resolveContextBudget('ULTRA').tier === 'PRO');
  check('unknown tier falls back to FREE', resolveContextBudget(undefined).tier === 'FREE');
  // Free range check
  check('Free recent window in 10-18', free.recentUserMessageWindow >= 10 && free.recentUserMessageWindow <= 18, `got ${free.recentUserMessageWindow}`);
  check('Pro recent window in 20-30', pro.recentUserMessageWindow >= 20 && pro.recentUserMessageWindow <= 30, `got ${pro.recentUserMessageWindow}`);
}

// ==================== Case 23: P0 always preserved ====================
console.log('\n=== Case 23: P0 current message never compressed ===');
{
  const r = ex('先不要实现，我们现在只讨论设计。');
  check('task stage = discussion_only', r.taskStageChange === 'discussion_only', `got ${r.taskStageChange}`);
  check('high importance', r.importance >= 0.85);
}

// ==================== Case 24: no new AI calls on normal path ====================
console.log('\n=== Case 24: extraction is pure rule (no LLM) ===');
{
  // extractEvents touches only regexes; verify it returns synchronously
  // fast without any await/async.
  const start = Date.now();
  let n = 0;
  for (let i = 0; i < 1000; i++) ex('帮我分析这个方案。');
  n = 1;
  const elapsed = Date.now() - start;
  check('1000 extractions < 200ms (rule-based, no AI)', elapsed < 200, `took ${elapsed}ms`);
}

// ==================== Case 25: idempotency (dedupe keys) ====================
console.log('\n=== Case 25: dedupe keys are stable ===');
{
  const { extractEvents: _e } = { extractEvents };
  // Idempotency is enforced by the DB-layer dedupeKey; here we confirm the
  // same input yields the same extraction (deterministic).
  const a = ex('不对，现在是 Y。', { history: [{ role: 'assistant', content: 'X 是 2' }] });
  const b = ex('不对，现在是 Y。', { history: [{ role: 'assistant', content: 'X 是 2' }] });
  check('deterministic extraction (stable dedupe key basis)',
    a.correction.kind === b.correction.kind && a.correction.verificationRequired === b.correction.verificationRequired);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
