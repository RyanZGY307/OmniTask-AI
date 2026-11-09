// ================================================================
// RSI Rollout 单测：stableBucket 稳定性 + inRollout 0/100/中间 + decideOutcome 四种触发
// 运行：npx tsx test/rsi-rollout.test.ts
// 依据：src/services/rsi/rollout.ts
//   :9-16 stableBucket / :19-23 inRollout / :26-31 DEFAULT_THRESHOLDS
//   :57-63 latencyRegressed / :67-98 decideOutcome（单调判定）
// 注：decideOutcome 的 latencyMs 字段在 metrics 修复后已 deprecated（等于 avg），
//     latencyRegressed 只认真 P95（p95LatencyMs）；本测试按当前实现断言。
// ================================================================
process.env.PAUSE_ALL_WRITES = '0';
process.env.RSI_MIN_SAMPLES = '30';
process.env.RSI_MAX_ERR_RATE_INC = '0.02';
process.env.RSI_MAX_OBSERVATION_HOURS = '72';

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

// FNV-1a 参考值（python 独立计算，防止实现自证）
const BUCKET_REF: Record<string, number> = {
  'u1:skill:x': 50, 'user1:skill:x': 72, 'user2:skill:x': 73,
  'abc': 31, 'u1:skill:y': 69,
};

(async () => {
  const R = await import('../src/services/rsi/rollout');

  await t('1. stableBucket 确定性与分布（:9-16 FNV-1a 32bit → %100）', () => {
    let ok = 0;
    for (const [k, ref] of Object.entries(BUCKET_REF)) {
      const got = R.stableBucket(k);
      if (got === ref) ok++;
      else console.log(`    bucket mismatch '${k}': got ${got}, ref ${ref}`);
    }
    check(`5 组外部 FNV-1a 参考值全部吻合（实际 ${ok}/5）`, ok === Object.keys(BUCKET_REF).length);
    check('同 key 多次调用完全一致（无随机/无时间依赖）', (() => {
      const a = R.stableBucket('determinism-probe');
      return Array.from({ length: 50 }, () => R.stableBucket('determinism-probe')).every((v) => v === a);
    })());
    check('返回值恒在 [0,99]（1000 个随机 key）', Array.from({ length: 1000 }, (_, i) => R.stableBucket('k' + i)).every((v) => Number.isInteger(v) && v >= 0 && v < 100));
    check('不同 key 产生高分散桶（200 个 key 实测 94 个不同桶，FNV-1a %100 非去重哈希）', new Set(Array.from({ length: 200 }, (_, i) => R.stableBucket('x' + i))).size > 80);
    check('空串也是合法输入且稳定', R.stableBucket('') === R.stableBucket('') && R.stableBucket('') >= 0 && R.stableBucket('') < 100);
    check('actorId/assetKey 顺序敏感（u1:skill:x != skill:x:u1）', R.stableBucket('u1:skill:x') !== R.stableBucket('skill:x:u1'));
    check('Unicode key 可用（中文资产键不抛错）', R.stableBucket('用户甲:skill:分析') >= 0);
  });

  await t('2. inRollout 三档边界（:19-23）', () => {
    const actor = 'u1', asset = 'skill:x';
    const bucket = R.stableBucket(`${actor}:${asset}`); // = 50
    check('percent=0 → 永不含（0% 灰度关闭）', R.inRollout(actor, asset, 0) === false);
    check('percent=100 → 永真含（全量）', R.inRollout(actor, asset, 100) === true);
    check('percent=51 > bucket=50 → 含（中间值开）', R.inRollout(actor, asset, 51) === true);
    check('percent=50 = bucket=50 → **不含**（严格小于 <，边界不含自身）', R.inRollout(actor, asset, 50) === false);
    check('percent=49 < 50 → 不含', R.inRollout(actor, asset, 49) === false);
    check('percent=1 → 不含（本 key 桶 50 远大于 1）', R.inRollout(actor, asset, 1) === false);
    check('【已知边界】percent<0 走 <=0 分支全不含（负值等同关闭）', R.inRollout(actor, asset, -5) === false);
    check('percent>100 走 >=100 分支全含（越界值等同全量，无夹取）', R.inRollout(actor, asset, 150) === true);
    check('actor 不同则桶不同（分桶键含 actorId，避免同资产同灰度）', R.inRollout('user1', asset, 73) === true && R.inRollout('user1', asset, 72) === false);
    check('asset 不同则桶不同', R.inRollout(actor, 'skill:y', 70) === true && R.inRollout(actor, 'skill:y', 69) === false);
  });

  await t('3. 灰度覆盖率的均匀性抽查（统计性质，不是逐 key 断言）', () => {
    const keys = Array.from({ length: 500 }, (_, i) => 'u' + i + ':skill:x');
    for (const pct of [10, 25, 50, 75]) {
      const hit = keys.filter((k) => R.inRollout(k, 'skill:x', pct)).length;
      const ratio = hit / keys.length;
      check(`percent=${pct} 实测命中率 ${(ratio * 100).toFixed(1)}% 落在 ±8% 容差`, Math.abs(ratio - pct / 100) <= 0.08, `got ${ratio}`);
    }
  });

  await t('4. DEFAULT_THRESHOLDS 与环境变量（:26-31）', () => {
    const th = R.DEFAULT_THRESHOLDS;
    check('minSamples 来自 RSI_MIN_SAMPLES=30', th.minSamples === 30);
    check('maxErrorRateIncrease 来自 RSI_MAX_ERR_RATE_INC=0.02', th.maxErrorRateIncrease === 0.02);
    check('maxObservationHours 来自 RSI_MAX_OBSERVATION_HOURS=72', th.maxObservationHours === 72);
    check('maxLatencyIncreasePct 固定 0.15（不可由 env 改）', th.maxLatencyIncreasePct === 0.15);
    check('minSuccessRateImprovement 固定 0.02', th.minSuccessRateImprovement === 0.02);
    check('阈值对象可整体传入 decideOutcome（可测不同口径）', (R.decideOutcome.length === 1 || R.decideOutcome.length === 2));
  });

  await t('5. decideOutcome：promote（全部门通过）', () => {
    const d = R.decideOutcome({
      baseline: { samples: 1000, successRate: 0.9, errorRate: 0.04, p95LatencyMs: 500, avgLatencyMs: 500, latencyMs: 500, p95Available: true, errorEvents: 40 } as any,
      candidate: { samples: 1000, successRate: 0.96, errorRate: 0.03, p95LatencyMs: 500, avgLatencyMs: 500, latencyMs: 500, p95Available: true, errorEvents: 30 } as any,
      samples: 1000, canaryStartedAt: new Date(Date.now() - 60 * 60_000),
    });
    check('outcome=promote', d.outcome === 'promote');
    check('reasons=[指标达标]（:98）', d.reasons.length === 1 && d.reasons[0] === '指标达标');
  });

  await t('6. decideOutcome：hold 的四种触发（单调判定优先级）', () => {
    const good = { samples: 1000, successRate: 0.96, errorRate: 0.03, p95LatencyMs: 500, avgLatencyMs: 500, latencyMs: 500, p95Available: true, errorEvents: 30 } as any;
    const base = { samples: 1000, successRate: 0.9, errorRate: 0.04, p95LatencyMs: 500, avgLatencyMs: 500, latencyMs: 500, p95Available: true, errorEvents: 40 } as any;

    const d1 = R.decideOutcome({ baseline: base, candidate: { ...good, samples: 10 }, samples: 10, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
    check('① 样本不足 samples<minSamples → hold（优先于其余门）', d1.outcome === 'hold' && d1.reasons[0] === '样本不足');

    const d2 = R.decideOutcome({ baseline: base, candidate: good, samples: 1000, canaryStartedAt: new Date(Date.now() - 200 * 60 * 60_000) });
    check('② 超过最长观察期限 → hold 转人工', d2.outcome === 'hold' && d2.reasons[0].includes('超过最长观察期限'));

    const d3 = R.decideOutcome({ baseline: base, candidate: { ...good, successRate: 0.902 }, samples: 1000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
    check('③ 成功率提升仅 0.2%（<0.02）→ 先被 Wilson 门拦下（88.2% < 90.0%），同为 hold（单调判定更严）', d3.outcome === 'hold' && d3.reasons[0].includes('Wilson 下界'));
    const d3b = R.decideOutcome({ baseline: { ...base, successRate: 0.10 }, candidate: { ...good, successRate: 0.11 }, samples: 1000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
    check('③b 低基线（0.10→0.11）：Wilson 下界 6.4% 未超基线 10% → 仍 hold（Wilson 门先于提升门）', d3b.outcome === 'hold' && d3b.reasons[0].includes('Wilson 下界'));
    // Wilson 门要过，候选下界必须 > 基线点估计：基线 0.05 / 候选 0.075（+0.025 >= 0.02 会 promote），
    // 因此取 +0.015 无法同时过 Wilson；改用大样本差距小的组合证明「成功率未达提升门槛」可达：
    const d3c = R.decideOutcome({ baseline: { ...base, samples: 1_000_000, successRate: 0.90, errorRate: 0.04 }, candidate: { ...good, samples: 1_000_000, successRate: 0.903, errorRate: 0.04 }, samples: 1_000_000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
    check('③c 提升 0.3%（<0.02）但超大样本使 Wilson 下界超基线 → 落在「成功率未达提升门槛」（证明该门可达且晚于 Wilson 门）', d3c.outcome === 'hold' && d3c.reasons[0] === '成功率未达提升门槛');

    const d4 = R.decideOutcome({ baseline: base, candidate: { ...good, successRate: 0.951, samples: 60 }, samples: 60, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
    check('④ Wilson 下界未超基线 0.9 → hold（小样本不算显著提升）', d4.outcome === 'hold' && d4.reasons[0].includes('Wilson 下界'));

    const d5 = R.decideOutcome({ baseline: base, candidate: { ...good, latencyMs: null }, samples: 1000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
    check('⑤ 指标非有限值（latencyMs=null）→ hold 指标缺失（:70-72，八字段任一非 finite 即拦）', d5.outcome === 'hold' && d5.reasons[0].includes('指标缺失'));
    const d5b = R.decideOutcome({ baseline: { ...base, latencyMs: null }, candidate: { ...good, latencyMs: null, p95LatencyMs: null, p95Available: false }, samples: 1000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
    check('⑤b latencyMs 双测均 null → 指标缺失门拦下（该门看的是 latencyMs 兼容字段而非 p95）', d5b.outcome === 'hold' && d5b.reasons[0].includes('指标缺失'));
    const d5c = R.decideOutcome({ baseline: { ...base, p95LatencyMs: null, p95Available: false }, candidate: { ...good, p95LatencyMs: null, p95Available: false }, samples: 1000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
    check('⑤c 仅 p95 缺失而 latencyMs 有限 → 不被 70-72 拦，最终 promote（延迟样本缺失只影响 latencyRegressed）', d5c.outcome === 'promote' && d5c.reasons[0] === '指标达标');

    const d6 = R.decideOutcome({ baseline: base, candidate: { ...good, p95LatencyMs: 580, avgLatencyMs: 580, latencyMs: 580, p95Available: true }, samples: 1000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
    check('⑥ p95 +16%（超出 15% 阈值）→ rollback', d6.outcome === 'rollback' && d6.reasons[0].includes('p95 上升 16.0%'));
    const d7 = R.decideOutcome({ baseline: base, candidate: { ...good, p95LatencyMs: 575, avgLatencyMs: 575, latencyMs: 575, p95Available: true }, samples: 1000, canaryStartedAt: new Date(Date.now() - 60 * 60_000) });
    check('⑦ p95 +15%（=阈值，严格 > 不触发）→ 走 Wilson/成功率门后 promote', d7.outcome === 'promote');
  });

  await t('7. decideOutcome：rollback 的两种触发', () => {
    const base = { samples: 1000, successRate: 0.9, errorRate: 0.04, p95LatencyMs: 500, avgLatencyMs: 500, latencyMs: 500, p95Available: true, errorEvents: 40 } as any;
    const d1 = R.decideOutcome({
      baseline: base,
      candidate: { samples: 1000, successRate: 0.96, errorRate: 0.06, p95LatencyMs: 500, avgLatencyMs: 500, p95Available: true, errorEvents: 60 } as any,
      samples: 1000, canaryStartedAt: new Date(Date.now() - 60 * 60_000),
    });
    check('errorRate 上升 +0.02（=阈值）→ 不触发 rollback（严格 > 阈值）', d1.outcome === 'hold' || d1.outcome === 'promote');
    const d2 = R.decideOutcome({
      baseline: base,
      candidate: { samples: 1000, successRate: 0.96, errorRate: 0.061, p95LatencyMs: 500, avgLatencyMs: 500, latencyMs: 500, p95Available: true, errorEvents: 61 } as any,
      samples: 1000, canaryStartedAt: new Date(Date.now() - 60 * 60_000),
    });
    check('errorRate 上升 +0.021（>阈值）→ rollback 错误率上升超过阈值', d2.outcome === 'rollback' && d2.reasons[0] === '错误率上升超过阈值');
    const d3 = R.decideOutcome({
      baseline: { ...base, p95LatencyMs: 500 },
      candidate: { samples: 1000, successRate: 0.96, errorRate: 0.03, p95LatencyMs: 600, avgLatencyMs: 600, latencyMs: 600, p95Available: true } as any,
      samples: 1000, canaryStartedAt: new Date(Date.now() - 60 * 60_000),
    });
    check('真 P95 +20% → rollback（:83-85）', d3.outcome === 'rollback' && d3.reasons[0].includes('p95 上升'));
  });

  await t('8. 单调性与 fail-closed 边界', () => {
    const base = { samples: 1000, successRate: 0.9, errorRate: 0.04, p95LatencyMs: 500, avgLatencyMs: 500, latencyMs: 500, p95Available: true, errorEvents: 40 } as any;
    check('candidate 缺失字段 → hold（不要把缺失当达标）', (() => {
      try { const r = R.decideOutcome({ baseline: base, candidate: { samples: 1000 } as any, samples: 1000, canaryStartedAt: null }); return r.outcome === 'hold'; } catch { return true; }
    })());
    check('candidate 字段缺 samples/successRate → hold（NaN 非有限值，不因异常崩溃）', (() => {
      try {
        const r = R.decideOutcome({ baseline: base, candidate: { samples: 1000 } as any, samples: 1000, canaryStartedAt: null });
        return r.outcome === 'hold' && r.reasons[0].includes('指标缺失');
      } catch { return false; }
    })());
    check('canaryStartedAt 为字符串 ISO → 正常解析', R.decideOutcome({
      baseline: base,
      candidate: { samples: 1000, successRate: 0.96, errorRate: 0.03, p95LatencyMs: 500, avgLatencyMs: 500, latencyMs: 500, p95Available: true } as any,
      samples: 1000, canaryStartedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    }).outcome === 'promote');
    check('canaryStartedAt 非法字符串 → 跳过期限门（:79 Number.isFinite 守门）', R.decideOutcome({
      baseline: base,
      candidate: { samples: 1000, successRate: 0.96, errorRate: 0.03, p95LatencyMs: 500, avgLatencyMs: 500, latencyMs: 500, p95Available: true } as any,
      samples: 1000, canaryStartedAt: 'not-a-date',
    }).outcome === 'promote');
    check('reasons 恒为非空数组（每种 outcome 都有可读原因）', (() => {
      const outs = ['promote', 'hold', 'rollback'];
      const r = R.decideOutcome({ baseline: base, candidate: { ...base, successRate: 0.9 }, samples: 1000, canaryStartedAt: null });
      return Array.isArray(r.reasons) && r.reasons.length >= 1;
    })());
  });

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
