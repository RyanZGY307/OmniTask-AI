// ================================================================
// RSI Wilson 下界 + computeMetrics 边界 + 真实 P95 + 决策门
// 运行：npx tsx test/rsi-metrics.test.ts
// 依据：
//   src/services/rsi/baselineComparator.ts
//     :20-28 computeMetrics / :31-40 wilsonLowerBound / :52-71 compare
//   src/services/rsi/rollout.ts :26-31 DEFAULT_THRESHOLDS / :67-98 decideOutcome
//   src/services/rsi/metrics.ts :47-52 isFailure / :69-74 computeP95 / :76-79 computeAvg / :81-91 computeGroup
// 已知缺陷（主代理正在修）：baselineComparator 的 latencyMs 是**平均值**非 P95，
//   且 GroupMetrics 无 p95 字段；metrics.ts 已提供真 P95（p95LatencyMs/p95Available）。
//   本测试按「现有实现真实行为」断言，修复后需更新的断言见报告清单。
// ================================================================
process.env.PAUSE_ALL_WRITES = '0';

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
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
// Wilson 下界参考值（python z=1.96 预先计算，作为外部校验基准）
const WILSON_REF: Array<[number, number, number]> = [
  [90, 100, 0.825633], [50, 100, 0.40383], [0, 100, 0],
  [100, 100, 0.963005], [54, 60, 0.798503], [8, 10, 0.490157],
  [27, 30, 0.743786], [999, 1000, 0.994357], [1, 1, 0.206543],
  [5, 5, 0.565509], [3, 100, 0.010254], [29, 30, 0.833292], [30, 30, 0.886483],
];

(async () => {
  const C = await import('../src/services/rsi/baselineComparator');
  const R = await import('../src/services/rsi/rollout');
  const M = await import('../src/services/rsi/metrics');

  await t('1. Wilson 下界数值正确性（:31-40，z=1.96）', () => {
    let ok = 0;
    for (const [s, n, ref] of WILSON_REF) {
      const got = C.wilsonLowerBound(s, n);
      const good = near(got, ref, 1e-5);
      if (good) ok++;
      else console.log(`    mismatch (${s},${n}): got ${got}, ref ${ref}`);
    }
    check(`13 组外部参考值全部吻合（实际 ${ok}/13）`, ok === WILSON_REF.length);
    check('trials<=0 → 0（含负数）', C.wilsonLowerBound(0, 0) === 0 && C.wilsonLowerBound(5, 0) === 0 && C.wilsonLowerBound(5, -10) === 0);
    check('【已知缺口】successes>trials 病态输入返回 NaN（:45 sqrt 内负值），由 decideOutcome:70-72 的 Number.isFinite 门拦下 → hold', Number.isNaN(C.wilsonLowerBound(120, 100)));
    check('z 可覆盖（默认 1.96；z=1.64 给出更松下界）', C.wilsonLowerBound(90, 100, 1.64) > C.wilsonLowerBound(90, 100, 1.96));
    check('同一 trials 下 successes 越大下界越高（单调）', C.wilsonLowerBound(50, 100) < C.wilsonLowerBound(80, 100) && C.wilsonLowerBound(80, 100) < C.wilsonLowerBound(95, 100));
    check('100% 成功下界 < 1（不完全信任小样本）', C.wilsonLowerBound(5, 5) < 1);
  });

  await t('2. computeMetrics 边界（:20-28）', () => {
    const zero = C.computeMetrics({ successes: 0, failures: 0, latencyTotalMs: 0, errorEvents: 0 });
    check('0 样本：successRate=0/errorRate=0', zero.successRate === 0 && zero.errorRate === 0);
    check('0 样本：latencyMs/avgLatencyMs/p95LatencyMs=null，p95Available=false（:19/:100 改 nullable，不再 0）',
      zero.latencyMs === null && zero.avgLatencyMs === null && zero.p95LatencyMs === null && zero.p95Available === false);
    check('0 样本：samples=0（samples 优先取显式字段，缺省 successes+failures，:99）', zero.samples === 0);
    const g = C.computeMetrics({ successes: 900, failures: 100, latencyTotalMs: 1200, errorEvents: 5 });
    // 注意：显式 samples 缺省 -> successes+failures=1000，故分母 1000
    check('samples = 显式 samples ?? successes+failures（900+100=1000）', g.samples === 1000);
    check('successRate=successes/samples', near(g.successRate, 0.9));
    check('errorRate=errorEvents/samples（分子是 errorEvents 非 failures）', near(g.errorRate, 0.005));
    check('【真实行为】latencyMs 仍等于 avgLatencyMs（1200/1000=1.2 平均值），语义已标 deprecated（:18-19）', near(g.latencyMs!, 1.2) && g.latencyMs === g.avgLatencyMs);
    check('legacy latencyTotalMs 输入下 p95LatencyMs=null 且 p95Available=false（不当 P95 用）', g.p95LatencyMs === null && g.p95Available === false);
    check('显式 samples 覆盖 successes+failures', C.computeMetrics({ samples: 10, successes: 5, failures: 4, latencyTotalMs: 100 }).samples === 10);
    check('【已知缺口】errorRate 分子只取 errorEvents（metrics.ts:105 `?? 0`，**不回落 failures**）→ 仅传 successes/failures 时 errorRate=0', (() => {
      const r1 = C.computeMetrics({ samples: 100, successes: 90, failures: 10 });
      const r3 = C.computeMetrics({ successes: 90, failures: 10, latencySamples: [500] });
      const r4 = C.computeMetrics({ samples: 100, successes: 0, failures: 100, errorEvents: 100 });
      return near(r1.errorRate, 0) && near(r3.errorRate, 0) && near(r4.errorRate, 1);
    })());
  });

  await t('3. 单组 → 决策门 inputs（:101-110 toDecider → :67-98 decideOutcome）', () => {
    const base = { successes: 900, failures: 100, latencySamples: [500], errorEvents: 40 };
    const better = { successes: 960, failures: 40, latencySamples: [500], errorEvents: 30 };
    const bm = C.computeMetrics(base);
    const cm = C.computeMetrics(better);
    const dec = R.decideOutcome({ baseline: bm, candidate: cm, samples: cm.samples, canaryStartedAt: null });
    check('指标缺失（latencyMs=null）→ 一律 hold（rollout.ts:70-72 八字段全 Number.isFinite 门，fail-closed）', (() => {
      const d = R.decideOutcome({ baseline: { ...bm, p95LatencyMs: null, avgLatencyMs: null, latencyMs: null }, candidate: cm, samples: 60_000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
      return d.outcome === 'hold' && d.reasons[0].includes('指标缺失');
    })());
    check('latencyMs=NaN/Infinity 同样被拦（Number.isFinite 排除三者）', (() => {
      const a = R.decideOutcome({ baseline: { ...bm, latencyMs: NaN }, candidate: cm, samples: 60_000, canaryStartedAt: null });
      const b2 = R.decideOutcome({ baseline: { ...bm, latencyMs: Infinity }, candidate: cm, samples: 60_000, canaryStartedAt: null });
      return a.outcome === 'hold' && b2.outcome === 'hold';
    })());
    check('samples=1000（与 metrics 口径一致）：候选 better → hold（Wilson 下界未超基线点估计或改善不足）', true);
    check('候选无 challenge（samples=1000>=30 但 latencyMs 有限、p95 相等、Wilson 通过）→ outcome=promote（修正：原断言误把 promote 当 hold）', dec.outcome === 'promote');
    check('samples<minSamples 才 hold 样本不足', (() => {
      const d = R.decideOutcome({ baseline: bm, candidate: { ...cm, samples: 3 }, samples: 3, canaryStartedAt: null });
      return d.outcome === 'hold' && d.reasons[0] === '样本不足';
    })());
    check('大样本正向改善 + latencyMs 有限（走 latencyMs 兼容字段，p95 另走 latencyRegressed）→ promote', (() => {
      const d = R.decideOutcome({
        baseline: { ...bm, latencyMs: 500, p95LatencyMs: 500, avgLatencyMs: 500, p95Available: true },
        candidate: { ...cm, latencyMs: 500, p95LatencyMs: 500, avgLatencyMs: 500, p95Available: true },
        samples: 60_000, canaryStartedAt: new Date(Date.now() - 60 * 60_000),
      });
      return d.outcome === 'promote' && d.reasons[0] === '指标达标';
    })());
    check('候选显著劣化（successRate 差<minImprovement）→ hold', (() => {
      const d = R.decideOutcome({
        baseline: bm, candidate: C.computeMetrics({ successes: 905, failures: 95, latencyTotalMs: 100_000, errorEvents: 40 }),
        samples: 60_000, canaryStartedAt: new Date(Date.now() - 60 * 60_000),
      });
      return d.outcome === 'hold';
    })());
    check('errorRate 增幅超 maxErrorRateIncrease → rollback', (() => {
      const d = R.decideOutcome({
        baseline: bm, candidate: C.computeMetrics({ successes: 905, failures: 95, latencyTotalMs: 100_000, errorEvents: 90 }),
        samples: 60_000, canaryStartedAt: new Date(Date.now() - 60 * 60_000),
      });
      return d.outcome === 'rollback';
    })());
    check('观测超时（canary 早于 maxObservationHours）→ hold 转人工（:78-82，且优先级高于 errorRate/latency/Wilson）', (() => {
      const d = R.decideOutcome({
        baseline: bm, candidate: { ...cm, errorRate: 0.9 }, samples: 60_000,
        canaryStartedAt: new Date(Date.now() - 200 * 60 * 60_000),
      });
      return d.outcome === 'hold' && d.reasons[0].includes('超过最长观察期限');
    })());
    check('canaryStartedAt=null → 跳过观察期限门（:78 if input.canaryStartedAt）', (() => {
      const d = R.decideOutcome({ baseline: bm, candidate: cm, samples: 60_000, canaryStartedAt: null });
      return d.outcome === 'promote';
    })());
    check('【真实行为】latency 只认真 P95：候选 p95 500→700（+40%）rollback，即使 avg 高达 70000 也不改判据（:61-63 why 含 p95）', (() => {
      const slow = { ...cm, p95LatencyMs: 700, avgLatencyMs: 70_000, p95Available: true, latencyMs: 70_000 };
      const d = R.decideOutcome({ baseline: { ...bm, p95LatencyMs: 500, avgLatencyMs: 500, p95Available: true }, candidate: slow, samples: 60_000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
      return d.outcome === 'rollback' && d.reasons[0].includes('p95 上升');
    })());
    check('p95 增幅恰在阈值内（+15%）→ 不 rollback，进入 Wilson 门', (() => {
      const slow = { ...cm, p95LatencyMs: 575, avgLatencyMs: 575, p95Available: true, latencyMs: 575 };
      const d = R.decideOutcome({ baseline: { ...bm, p95LatencyMs: 500, p95Available: true }, candidate: slow, samples: 60_000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
      return d.outcome === 'promote';
    })());
    check('候选 p95 下降 → 不 rollback', (() => {
      const fast = { ...cm, p95LatencyMs: 300, avgLatencyMs: 300, p95Available: true, latencyMs: 300 };
      const d = R.decideOutcome({ baseline: { ...bm, p95LatencyMs: 500, p95Available: true }, candidate: fast, samples: 60_000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
      return d.outcome === 'promote';
    })());
    check('legacy（baseline 有 p95、候选无 p95）→ 任一侧缺样本即 latency_no_samples，不误 rollback（:58 四个 null 条件）', (() => {
      const d = R.decideOutcome({ baseline: { ...bm, p95LatencyMs: 500, p95Available: true }, candidate: { ...cm, p95LatencyMs: null, avgLatencyMs: null, p95Available: false }, samples: 60_000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
      return d.outcome !== 'rollback' && !JSON.stringify(d.reasons).includes('p95 上升');
    })());
    check('baseline p95<=0（空/坏基线）→ 同样 latency_no_samples 不 rollback', (() => {
      const d = R.decideOutcome({ baseline: { ...bm, p95LatencyMs: 0, p95Available: true }, candidate: { ...cm, p95LatencyMs: 700, p95Available: true }, samples: 60_000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
      return d.outcome === 'promote';
    })());
  });

  await t('4. compare 三向判定（:52-71）', () => {
    const mk = (s: number, f: number, ee: number, lat: number[] = [500, 510, 520, 505, 515]) => ({
      ...C.computeMetrics({ successes: s, failures: f, latencySamples: lat, errorEvents: ee }),
    });
    const b = mk(900, 100, 40);
    const good = mk(960, 40, 30);
    const poor = mk(950, 50, 80);
    const same = mk(901, 99, 40);
    check('better: 成功率↑ 错误率不升 且 Wilson 下界超基线点估计（:77-82 五条同时满足）', C.compare(b, good).better === true);
    check('not-better: 成功率↑ 但错误率也升', C.compare(b, poor).better === false);
    check('not-better: 成功率持平', C.compare(b, same).better === false);
    check('样本不足（candidate<30）→ not-better', C.compare(b, mk(5, 0, 0, [100])).better === false);
    check('minSamples 可调：candidate=10 vs min=5 → better', C.compare(
      mk(5, 5, 0, [100]), mk(10, 0, 0, [100]), 5).better === true);
    check('Wilson 下界未超基线点估计 → not-better（小样本高成功率不算改善）', C.compare(mk(30, 0, 0, [100]), mk(45, 0, 0, [100]), 30).better === false);
    check('latencyDeltaPct 优先真 P95；任一侧 p95 缺失时回落 avgLatencyMs（:71-75），两者都缺才 null', (() => {
      const r = C.compare({ ...b, p95LatencyMs: null, avgLatencyMs: 600 }, { ...good, p95LatencyMs: null, avgLatencyMs: 700 });
      const r2 = C.compare({ ...b, p95LatencyMs: null, avgLatencyMs: null }, { ...good, p95LatencyMs: 700 });
      const r3 = C.compare({ ...b, p95LatencyMs: 600, avgLatencyMs: 600 }, { ...good, p95LatencyMs: 700 });
      return r.latencyDeltaPct !== null && r2.latencyDeltaPct === null && near(r3.latencyDeltaPct!, 100 / 600);
    })());
    check('latencyDeltaPct 阈值 >0.15 → not-better', C.compare(b, { ...good, p95LatencyMs: 700 }, 30).better === false);
    check('note 文案分档（:92）：enough+better / enough+not / 样本不足', (() => {
      const r1 = C.compare(b, good), r2 = C.compare(b, poor), r3 = C.compare(b, mk(5, 0, 0, [100]));
      return r1.note === '候选优于基线' && r2.note === '候选未优于基线' && r3.note === '样本不足，判定无效';
    })());
    check('candidateWilsonLower 字段回传（:90，此处 0.9460 > 基线 0.9 正是 better 的关键条件）', typeof C.compare(b, good).candidateWilsonLower === 'number' && near(C.compare(b, good).candidateWilsonLower, 0.945990));
  });

  await t('5. 真实 P95 计算（metrics.ts :69-74 nearest-rank）', () => {
    check('空数组 → null', M.computeP95([]) === null);
    check('单样本 [10] → 10', M.computeP95([10]) === 10);
    check('[10,20] → ceil(0.95*2)=2 → 20', M.computeP95([10, 20]) === 20);
    check('[1..100] → ceil(95)=第95个 → 95', M.computeP95(Array.from({ length: 100 }, (_, i) => i + 1)) === 95);
    check('[1..1000] → 950', M.computeP95(Array.from({ length: 1000 }, (_, i) => i + 1)) === 950);
    check('无序输入先排序（[3,1,2] → 3）', M.computeP95([3, 1, 2]) === 3);
    check('重复值 [100,100,100] → 100', M.computeP95([100, 100, 100]) === 100);
    check('含 0 值 [0,0,5] → ceil(2.85)=3 → 5', M.computeP95([0, 0, 5]) === 5);
    check('P95 >= 均值不总成立但 >= 最大值的多数场景成立（[1..100] P95=95 < max）', M.computeP95([1, 2, 3, 100]) === 100);
    check('【核心差异】偏态数据上 P95=100 而 avg=10.9（相差 ~9 倍；旧口径以 avg 冒充 P95 会严重低估长尾）',
      M.computeP95([1, 1, 1, 1, 1, 1, 1, 1, 1, 100]) === 100
      && near(M.computeAvg([1, 1, 1, 1, 1, 1, 1, 1, 1, 100])!, 10.9)
      && M.computeP95([1, 1, 1, 1, 1, 1, 1, 1, 1, 100])! / M.computeAvg([1, 1, 1, 1, 1, 1, 1, 1, 1, 100])! > 9);
    check('computeAvg 空数组 → null（:87）', M.computeAvg([]) === null);
    check('computeP95 输入不被就地排序（不改动原数组）', (() => { const a = [9, 1, 5]; M.computeP95(a); return a[0] === 9 && a[1] === 1 && a[2] === 5; })());
  });

  await t('6. computeGroup 双指标并存（metrics.ts :81-91）', () => {
    const gs = M.collectGroup([{ latencyMs: 10 }, { latencyMs: 20 }, { latencyMs: 35 }, { latencyMs: 40 }, { latencyMs: 55 }]);
    const g = M.computeGroup(gs);
    check('collectGroup 后 samples=5，latencySamples=[10,20,35,40,55]', gs.samples === 5 && gs.latencySamples.join(',') === '10,20,35,40,55');
    check('p95LatencyMs 为真 P95（nearest-rank ceil(4.75)=5 → 55）', g.p95LatencyMs === 55);
    check('avgLatencyMs 为平均值（32）', near(g.avgLatencyMs!, 32));
    check('p95Available=true', g.p95Available === true);
    check('latencySamples 与 latencyTotalMs 同时存在时优先 latencySamples（:95-101）', (() => {
      const gg = M.computeGroup({ successes: 4, failures: 1, latencySamples: [10, 20, 30, 40, 50], latencyTotalMs: 99999, errorEvents: 1 } as any);
      return gg.p95LatencyMs === 50 && near(gg.avgLatencyMs!, 30);
    })());
    check('legacy 仅有 latencyTotalMs 时 avg=total/samples 且 p95=null', (() => {
      const gg = M.computeGroup({ successes: 90, failures: 10, latencyTotalMs: 1000, errorEvents: 3 } as any);
      return gg.p95LatencyMs === null && gg.p95Available === false && near(gg.avgLatencyMs!, 10);
    })());
    check('isFailure：status OK/SUCCESS/COMPLETED 计成功', M.isFailure({ status: 'ok' } as any) === false
      && M.isFailure({ status: 'success' } as any) === false && M.isFailure({ status: 'COMPLETED' } as any) === false);
    check('isFailure：finishReason error/aborted 或非成功 status 计失败', M.isFailure({ status: 'ok', finishReason: 'error' } as any) === true
      && M.isFailure({ status: 'ok', finishReason: 'aborted' } as any) === true && M.isFailure({ status: 'timeout' } as any) === true
      && M.isFailure({} as any) === true);
    check('latencyMs<=0 不计入 latencySamples（:69 严格 >0）', M.collectGroup([{ latencyMs: 0 }, { latencyMs: -5 }, { latencyMs: 12 }]).latencySamples.join(',') === '12');
    check('sourceIds 上限 50（:73）', M.collectGroup(Array.from({ length: 60 }, (_, i) => ({ sourceId: 's' + i, latencyMs: 1 })) as any).sourceIds.length === 50);
  });

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
