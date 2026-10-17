// Unit tests for the knowledge self-repair lifecycle (pure, no DB).
// Run from the dist output (server build already produced these):
//   node test/knowledgeLifecycle.test.js  (after `npm run build`)
// Or run the .ts source with a TS runner. This file is plain JS so it can be
// executed directly against the compiled dist modules.

const { computeAdaptiveInterval, isRefreshDispatchable } = require('../dist/services/knowledgeLifecycle/adaptiveInterval.js');
const { diffFactValues } = require('../dist/services/knowledgeLifecycle/factValueDiff.js');

const cfg = {
  maxConsecutiveFailures: 3,
  pauseCyclesAfterMaxFailures: 1,
  stableSteps: [1, 2, 3, 6, 12],
  hotStep: 0.5,
  currentCycle: '2026-09',
};

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
  }
}

console.log('\n=== adaptiveInterval (D2 state machine) ===');

{
  const r = computeAdaptiveInterval({
    ...cfg,
    prevIntervalMonths: 1,
    lastStatus: 'UNCHANGED',
    consecutiveFailureCountBefore: 0,
    unchangedStreakBefore: 0,
  });
  check('unchanged: streak increments', r.unchangedStreak === 1, `got ${r.unchangedStreak}`);
  check('unchanged: cadence steps up to 2mo', r.newIntervalMonths === 2, `got ${r.newIntervalMonths}`);
  check('unchanged: failure count stays 0', r.consecutiveFailureCount === 0);
}

{
  const r = computeAdaptiveInterval({
    ...cfg,
    prevIntervalMonths: 2,
    lastStatus: 'UNCHANGED',
    consecutiveFailureCountBefore: 0,
    unchangedStreakBefore: 1,
  });
  check('streak=2: cadence 3mo', r.newIntervalMonths === 3, `got ${r.newIntervalMonths}`);
}

{
  const r = computeAdaptiveInterval({
    ...cfg,
    prevIntervalMonths: 1,
    lastStatus: 'MINOR_CHANGE',
    consecutiveFailureCountBefore: 0,
    unchangedStreakBefore: 0,
  });
  check('minor: streak increments', r.unchangedStreak === 1, `got ${r.unchangedStreak}`);
}

{
  const r = computeAdaptiveInterval({
    ...cfg,
    prevIntervalMonths: 12,
    lastStatus: 'MATERIAL_CHANGE',
    consecutiveFailureCountBefore: 0,
    unchangedStreakBefore: 5,
  });
  check('material: streak resets to 0', r.unchangedStreak === 0, `got ${r.unchangedStreak}`);
  check('material: hot cadence 0.5mo', r.newIntervalMonths === 0.5, `got ${r.newIntervalMonths}`);
  check('material: priority HIGH', r.priority === 2, `got ${r.priority}`);
}

{
  const r = computeAdaptiveInterval({
    ...cfg,
    prevIntervalMonths: 6,
    lastStatus: 'REFRESH_FAILED',
    consecutiveFailureCountBefore: 0,
    unchangedStreakBefore: 4,
  });
  check('failed#1: failure count -> 1', r.consecutiveFailureCount === 1, `got ${r.consecutiveFailureCount}`);
  check('failed#1: unchanged streak untouched', r.unchangedStreak === 4, `got ${r.unchangedStreak}`);
  check('failed#1: cadence unchanged (6mo)', r.newIntervalMonths === 6, `got ${r.newIntervalMonths}`);
}

{
  const r1 = computeAdaptiveInterval({ ...cfg, prevIntervalMonths: 1, lastStatus: 'REFRESH_FAILED', consecutiveFailureCountBefore: 0, unchangedStreakBefore: 0 });
  check('fail#1 count', r1.consecutiveFailureCount === 1);
  const r2 = computeAdaptiveInterval({ ...cfg, prevIntervalMonths: 1, lastStatus: 'REFRESH_FAILED', consecutiveFailureCountBefore: 1, unchangedStreakBefore: 0 });
  check('fail#2 count', r2.consecutiveFailureCount === 2);
  check('fail#2 not yet paused', r2.pausedUntil === null, `got ${r2.pausedUntil}`);
  const r3 = computeAdaptiveInterval({ ...cfg, prevIntervalMonths: 1, lastStatus: 'REFRESH_FAILED', consecutiveFailureCountBefore: 2, unchangedStreakBefore: 0 });
  check('fail#3 hits cap -> paused', r3.pausedUntil !== null, `got ${r3.pausedUntil}`);
  check('fail#3 priority LOW', r3.priority === 4, `got ${r3.priority}`);
}

{
  const f1 = computeAdaptiveInterval({ ...cfg, prevIntervalMonths: 1, lastStatus: 'REFRESH_FAILED', consecutiveFailureCountBefore: 0, unchangedStreakBefore: 0 });
  const f2 = computeAdaptiveInterval({ ...cfg, prevIntervalMonths: 1, lastStatus: 'REFRESH_FAILED', consecutiveFailureCountBefore: f1.consecutiveFailureCount, unchangedStreakBefore: 0 });
  const success = computeAdaptiveInterval({ ...cfg, prevIntervalMonths: 1, lastStatus: 'UNCHANGED', consecutiveFailureCountBefore: f2.consecutiveFailureCount, unchangedStreakBefore: 0 });
  check('success resets failure count to 0', success.consecutiveFailureCount === 0, `got ${success.consecutiveFailureCount}`);
  const f3 = computeAdaptiveInterval({ ...cfg, prevIntervalMonths: 1, lastStatus: 'REFRESH_FAILED', consecutiveFailureCountBefore: success.consecutiveFailureCount, unchangedStreakBefore: success.unchangedStreak });
  check('fail after success counts as #1', f3.consecutiveFailureCount === 1, `got ${f3.consecutiveFailureCount}`);
  check('fail after success not paused', f3.pausedUntil === null, `got ${f3.pausedUntil}`);
}

{
  const r = computeAdaptiveInterval({ ...cfg, prevIntervalMonths: 3, lastStatus: 'CONFLICT', consecutiveFailureCountBefore: 2, unchangedStreakBefore: 1 });
  check('conflict: failure reset', r.consecutiveFailureCount === 0, `got ${r.consecutiveFailureCount}`);
  check('conflict: hot cadence', r.newIntervalMonths === 0.5, `got ${r.newIntervalMonths}`);
  check('conflict: priority HIGH', r.priority === 2, `got ${r.priority}`);
}

console.log('\n=== isRefreshDispatchable (D3 filter) ===');
check('ACTIVE + VERIFIED dispatchable', isRefreshDispatchable({ archived: false, pausedUntil: null, lifecycleStatus: 'ACTIVE', verificationStatus: 'VERIFIED' }) === true);
check('archived not dispatchable', isRefreshDispatchable({ archived: true, pausedUntil: null, lifecycleStatus: 'ACTIVE', verificationStatus: 'VERIFIED' }) === false);
check('MERGED lifecycle not dispatchable', isRefreshDispatchable({ archived: false, pausedUntil: null, lifecycleStatus: 'MERGED', verificationStatus: 'VERIFIED' }) === false);
check('pausedUntil in future not dispatchable', isRefreshDispatchable({ archived: false, pausedUntil: new Date(Date.now() + 86400000), lifecycleStatus: 'ACTIVE', verificationStatus: 'UNVERIFIED' }) === false);

console.log('\n=== factValueDiff (R5 structured comparison) ===');
check('"5000mAh" vs "5000 mAh" -> UNCHANGED/MINOR', ['UNCHANGED', 'MINOR_CHANGE'].includes(diffFactValues('搭载 5000mAh', '配备 5000 mAh')), `got ${diffFactValues('搭载 5000mAh', '配备 5000 mAh')}`);
check('"Android 15" vs "Android 16" -> MATERIAL', diffFactValues('支持 Android 15', '支持 Android 16') === 'MATERIAL_CHANGE', `got ${diffFactValues('支持 Android 15', '支持 Android 16')}`);
check('null new value -> UNVERIFIED', diffFactValues('x', null) === 'UNVERIFIED');
check('identical -> UNCHANGED', diffFactValues('5000mAh', '5000mAh') === 'UNCHANGED');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
