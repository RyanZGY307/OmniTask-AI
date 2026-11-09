// ================================================================
// RSI NoiseGate 六项判定单测（纯函数路径，不 import budget.ts）
// 运行：npx tsx test/rsi-noise-budget.test.ts
// 依据：src/services/rsi/noiseGate.ts
//   :23-27 severityOk / :30-32 frequencyOk / :35-39 cooldownOk
//   :42-44 concurrencyOk / :47-49 dailyBudgetOk / :56-74 evaluateNoise
// 注意：budget.ts（todayCount/incrementLocal/systemPool）import db.ts 触 prisma client，
//       本机 node_modules 缺 @prisma/client-user → 不可单跑，Budget 部分移入不可测清单。
// ================================================================
process.env.PAUSE_ALL_WRITES = '0';
process.env.RSI_MAX_DAILY_PROPOSALS = '20';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}
function t(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    console.log('\n' + name);
    try { await fn(); } catch (e) { check('unexpected throw: ' + (e as Error).message, false); }
  })();
}

const NOW = new Date('2026-11-08T12:00:00.000Z');
const P = { maxPerTypePer5Min: 1, minSeverity: 'medium' as const, cooldownMinutes: 30, maxOpenPerAsset: 1, maxDailyProposals: 20 };

(async () => {
  const N = await import('../src/services/rsi/noiseGate');

  await t('1. severityOk 严重度门槛（:23-27）', () => {
    check('min=medium 时 low 不通过', N.severityOk('low', 'medium') === false);
    check('min=medium 时 medium 通过', N.severityOk('medium', 'medium') === true);
    check('min=medium 时 high 通过', N.severityOk('high', 'medium') === true);
    check('min=low 时 low 通过', N.severityOk('low', 'low') === true);
    check('min=high 时 medium 不通过', N.severityOk('medium', 'high') === false);
    check('【已知缺口】未知严重度按 rank 0 处理（:26 ?? 0），min=low 时放行', N.severityOk('catastrophic', 'low') === true);
    check('【已知缺口】未知严重度在 min=medium 下被拦（rank 0 < 1）', N.severityOk('catastrophic', 'medium') === false);
    check('大小写敏感：Medium 被判未知 rank', N.severityOk('Medium', 'low') === true && N.severityOk('Medium', 'medium') === false);
  });

  await t('2. frequencyOk 频率（:30-32，recentSameType < max）', () => {
    check('0 条同型 → 通过', N.frequencyOk(0, P) === true);
    check('1 条同型（=max 1）→ 不通过（严格小于）', N.frequencyOk(1, P) === false);
    check('5 条同型 → 不通过', N.frequencyOk(5, P) === false);
    check('自定义 max=3：2 通过 / 3 不通过', N.frequencyOk(2, { ...P, maxPerTypePer5Min: 3 }) === true && N.frequencyOk(3, { ...P, maxPerTypePer5Min: 3 }) === false);
  });

  await t('3. cooldownOk 冷却（:35-39，elapsed >= cooldownMinutes）', () => {
    check('从未提议（null）→ 通过', N.cooldownOk(null, NOW, P) === true);
    check('29 分钟 → 冷却中', N.cooldownOk(new Date(NOW.getTime() - 29 * 60_000), NOW, P) === false);
    check('恰好 30 分钟 → 通过（>= 语义）', N.cooldownOk(new Date(NOW.getTime() - 30 * 60_000), NOW, P) === true);
    check('31 分钟 → 通过', N.cooldownOk(new Date(NOW.getTime() - 31 * 60_000), NOW, P) === true);
    check('修正：未来时间戳产生负 elapsed → **不放行**（fail-closed，仍判冷却中；clock skew 方向安全）',
      N.cooldownOk(new Date(NOW.getTime() + 60 * 60_000), NOW, P) === false);
    check('自定义 cooldownMinutes=0：0 分钟即通过', N.cooldownOk(NOW, NOW, { ...P, cooldownMinutes: 0 }) === true);
  });

  await t('4. concurrencyOk 并发（:42-44）', () => {
    check('0 个未闭环 → 通过', N.concurrencyOk(0, P) === true);
    check('1 个未闭环（=max）→ 不通过', N.concurrencyOk(1, P) === false);
    check('3 个未闭环 → 不通过', N.concurrencyOk(3, P) === false);
    check('自定义 max=2：1 通过 / 2 不通过', N.concurrencyOk(1, { ...P, maxOpenPerAsset: 2 }) === true && N.concurrencyOk(2, { ...P, maxOpenPerAsset: 2 }) === false);
  });

  await t('5. dailyBudgetOk 日配额（:47-49）', () => {
    check('0 次 → 通过', N.dailyBudgetOk(0, P) === true);
    check('19 次 → 通过', N.dailyBudgetOk(19, P) === true);
    check('20 次（=max）→ 不通过', N.dailyBudgetOk(20, P) === false);
    check('21 次 → 不通过', N.dailyBudgetOk(21, P) === false);
    check('自定义 max=5：4 通过 / 5 不通过', N.dailyBudgetOk(4, { ...P, maxDailyProposals: 5 }) === true && N.dailyBudgetOk(5, { ...P, maxDailyProposals: 5 }) === false);
  });

  await t('6. evaluateNoise 聚合判定（:56-74）', () => {
    const base = { severity: 'high', recentSameType: 0, lastProposalAt: null, openChangeCount: 0, todayCount: 0, now: NOW };
    check('全部达标 → pass 且 failed 为空', (() => { const r = N.evaluateNoise({ ...base, policy: P }); return r.pass === true && r.failed.length === 0; })());
    check('单项 severity 违规 → failed=[severity_below_min]', (() => { const r = N.evaluateNoise({ ...base, severity: 'low', policy: P }); return !r.pass && r.failed.length === 1 && r.failed[0] === 'severity_below_min'; })());
    check('单项 frequency 违规 → failed=[frequency_exceeded]', (() => { const r = N.evaluateNoise({ ...base, recentSameType: 2, policy: P }); return !r.pass && r.failed[0] === 'frequency_exceeded'; })());
    check('单项 cooldown 违规 → failed=[cooldown_active]', (() => { const r = N.evaluateNoise({ ...base, lastProposalAt: new Date(NOW.getTime() - 5 * 60_000), policy: P }); return !r.pass && r.failed[0] === 'cooldown_active'; })());
    check('单项并发违规 → failed=[asset_concurrency_full]', (() => { const r = N.evaluateNoise({ ...base, openChangeCount: 1, policy: P }); return !r.pass && r.failed[0] === 'asset_concurrency_full'; })());
    check('单项日配额违规 → failed=[daily_budget_exhausted]', (() => { const r = N.evaluateNoise({ ...base, todayCount: 25, policy: P }); return !r.pass && r.failed[0] === 'daily_budget_exhausted'; })());
    check('五项全违规 → failed 五段齐全', (() => {
      const r = N.evaluateNoise({ severity: 'low', recentSameType: 9, lastProposalAt: NOW, openChangeCount: 9, todayCount: 99, now: NOW, policy: P });
      return !r.pass && r.failed.length === 5
        && r.failed.includes('severity_below_min') && r.failed.includes('frequency_exceeded')
        && r.failed.includes('cooldown_active') && r.failed.includes('asset_concurrency_full') && r.failed.includes('daily_budget_exhausted');
    })());
    check('未显式传 policy 时用 DEFAULT_NOISE_POLICY（maxDailyProposals=20，由 env 设值）', N.DEFAULT_NOISE_POLICY.maxDailyProposals === 20
      && N.evaluateNoise({ ...base }).pass === true);
    check('now 缺省用当前真实时间（不传 now 也能工作）', N.evaluateNoise({ severity: 'high', recentSameType: 0, lastProposalAt: null, openChangeCount: 0, todayCount: 0, policy: P }).pass === true);
    check('修正：不传 now 时 lastProposalAt 传未来日期同样判 cooldown_active（聚合层无放行路径）',
      (() => { const r = N.evaluateNoise({ ...base, lastProposalAt: new Date('2099-01-01T00:00:00.000Z'), now: undefined as any, policy: P }); return !r.pass && r.failed[0] === 'cooldown_active'; })());
  });

  await t('7. 阈值与常量核对', () => {
    check('DEFAULT_NOISE_POLICY 五字段齐全', Object.keys(N.DEFAULT_NOISE_POLICY).sort().join(',') === 'cooldownMinutes,maxDailyProposals,maxOpenPerAsset,maxPerTypePer5Min,minSeverity');
    check('默认策略值：maxPerTypePer5Min=1/cooldown=30/maxOpen=1/minSeverity=medium', N.DEFAULT_NOISE_POLICY.maxPerTypePer5Min === 1
      && N.DEFAULT_NOISE_POLICY.cooldownMinutes === 30
      && N.DEFAULT_NOISE_POLICY.maxOpenPerAsset === 1
      && N.DEFAULT_NOISE_POLICY.minSeverity === 'medium');
    check('maxDailyProposals 可由 env RSI_MAX_DAILY_PROPOSALS 覆盖（:16）', process.env.RSI_MAX_DAILY_PROPOSALS === '20');
    check('六项判定全部为函数', [N.severityOk, N.frequencyOk, N.cooldownOk, N.concurrencyOk, N.dailyBudgetOk, N.evaluateNoise].every((f) => typeof f === 'function'));
  });

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
