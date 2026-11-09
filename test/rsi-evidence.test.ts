// ================================================================
// RSI EvidenceAssembler 单测：fail-closed 完整性 + 脱敏 + 保留期 + 样本量
// 运行：npx tsx test/rsi-evidence.test.ts
// 依据：src/services/rsi/evidenceAssembler.ts
//   :26-55 assembleEvidence / :58-70 summarizeForLongTerm / :73-75 enoughSamples / :78-80 pastRetention
//   :37 redactText(:36-50 in observability/pgStats.ts)
// 重要：DB 不可得时本测试全部走纯函数路径，不连库。
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

const SIG = [{ signalId: 's1', signalType: 'db_connection_failed', severity: 'high', createdAt: '2026-11-08T00:00:00.000Z', detail: '连接串 postgresql://u:p@h:5432/d 泄漏', raw: '原始对话含 password: xyz' }];
const BASE = { windowHours: 24, samples: 42, metrics: { errorRate: 0.12, successRate: 0.88 }, sourceIds: ['b1', 'b2'] };

(async () => {
  const E = await import('../src/services/rsi/evidenceAssembler');

  await t('1. 缺 signals 拒（fail-closed）', () => {
    const r = E.assembleEvidence({ signals: [], context: {}, baseline: BASE, history: [], currentVersion: 3, relatedChanges: 0 });
    check('空 signals → complete=false', r.complete === false);
    check('bundle 为 null', r.bundle === null);
    check('missing 含 signals', r.missing.includes('signals'));
    const r2 = E.assembleEvidence({ signals: undefined as any, context: {}, baseline: BASE, history: [], currentVersion: 3, relatedChanges: 0 });
    check('signals undefined → 同样拒', r2.complete === false && r2.missing.includes('signals'));
  });

  await t('2. 缺 baseline 拒', () => {
    const r = E.assembleEvidence({ signals: SIG, context: {}, baseline: null, history: [], currentVersion: 3, relatedChanges: 0 });
    check('baseline null → 拒且 missing 含 baseline', r.complete === false && r.missing.includes('baseline'));
    const r2 = E.assembleEvidence({ signals: SIG, context: {}, baseline: { windowHours: 24, samples: 0, metrics: {}, sourceIds: [] }, history: [], currentVersion: 3, relatedChanges: 0 });
    check('baseline.metrics 为空对象 → 拒（无指标等于无基线）', r2.complete === false && r2.missing.includes('baseline'));
    const r3 = E.assembleEvidence({ signals: SIG, context: {}, baseline: { windowHours: 24, samples: 5, metrics: undefined as any, sourceIds: [] }, history: [], currentVersion: 3, relatedChanges: 0 });
    check('baseline.metrics undefined → 拒', r3.complete === false && r3.missing.includes('baseline'));
    check('signals 与 baseline 同时缺失时 missing 含两项', (() => {
      const r4 = E.assembleEvidence({ signals: [], context: {}, baseline: null, history: [], currentVersion: null, relatedChanges: 0 });
      return r4.missing.includes('signals') && r4.missing.includes('baseline');
    })());
  });

  await t('3. currentVersion / relatedChanges 的缺失处理', () => {
    const r = E.assembleEvidence({ signals: SIG, context: {}, baseline: BASE, history: [], currentVersion: null, relatedChanges: 0 });
    check('【真实行为】currentVersion=null 仍判 complete（不阻断；版本缺失由 pipeline 侧后续校验）', r.complete === true);
    check('bundle.currentVersion 透传 null', r.bundle!.currentVersion === null);
    check('relatedChanges 透传', r.bundle!.relatedChanges === 7 ? true : (E.assembleEvidence({ signals: SIG, context: {}, baseline: BASE, history: [], currentVersion: 1, relatedChanges: 7 }).bundle!.relatedChanges === 7));
    check('currentVersion 有值时透传', E.assembleEvidence({ signals: SIG, context: {}, baseline: BASE, history: [], currentVersion: 12, relatedChanges: 0 }).bundle!.currentVersion === 12);
  });

  await t('4. 信号与上下文脱敏', () => {
    const r = E.assembleEvidence({ signals: SIG, context: { text: '用户密码 password: hunter2 与连接串 postgresql://u:p@h:5432/d', toolCalls: ['bash: ls', 'tool: read'] }, baseline: BASE, history: [], currentVersion: 3, relatedChanges: 0 });
    check('detail 中的连接串被脱敏', r.bundle!.signals[0].detail!.includes('[REDACTED:connection_string]') && !r.bundle!.signals[0].detail!.includes('u:p@'));
    check('detail 中不出现 user:pass 明文', !/\/\/u:p@/.test(r.bundle!.signals[0].detail ?? ''));
    check('contextSummary 已脱敏 password kv', r.bundle!.contextSummary.includes('[REDACTED:secret_kv]') && !r.bundle!.contextSummary.includes('hunter2'));
    check('contextSummary 不含原始连接串 userinfo', !r.bundle!.contextSummary.includes('u:p@'));
    check('signals 条数透传', r.bundle!.signals.length === 1);
    check('signalId/signalType/severity/createdAt 原样透传', r.bundle!.signals[0].signalId === 's1'
      && r.bundle!.signals[0].signalType === 'db_connection_failed'
      && r.bundle!.signals[0].severity === 'high'
      && r.bundle!.signals[0].createdAt === '2026-11-08T00:00:00.000Z');
    check('raw 字段不出现在 bundle（不落原始）', !JSON.stringify(r.bundle).includes('原始对话含'));
  });

  await t('5. history 截断与 assembledAt', () => {
    const history = Array.from({ length: 25 }, (_, i) => ({ evaluationId: 'e' + i, changeId: 'c' + i, decision: 'pass', metrics: { successRate: 0.9 }, createdAt: '2026-11-08T00:00:00.000Z' }));
    const r = E.assembleEvidence({ signals: SIG, context: {}, baseline: BASE, history, currentVersion: 3, relatedChanges: 2 });
    check('history 截断到最近 20 条（:49 slice(0,20)）', r.bundle!.history.length === 20);
    check('截断保留的是前 20 条（非尾部）', r.bundle!.history[0].evaluationId === 'e0' && r.bundle!.history[19].evaluationId === 'e19');
    check('assembledAt 为合法 ISO 串', !Number.isNaN(new Date(r.bundle!.assembledAt).getTime()));
    check('空 history 不报错', E.assembleEvidence({ signals: SIG, context: {}, baseline: BASE, history: [], currentVersion: null, relatedChanges: 0 }).complete);
  });

  await t('6. enoughSamples 样本门槛（:73-75，默认 30）', () => {
    const mk = (n: number) => ({ sampleCount: n, windowHours: 24, metrics: {}, sourceIds: [] });
    check('29 < 30 → false', E.enoughSamples(mk(29)) === false);
    check('30 = 30 → true', E.enoughSamples(mk(30)) === true);
    check('31 > 30 → true', E.enoughSamples(mk(31)) === true);
    check('自定义 minSamples=5：4 false / 5 true', E.enoughSamples(mk(4), 5) === false && E.enoughSamples(mk(5), 5) === true);
    check('null → false', E.enoughSamples(null) === false);
    check('0 样本 → false', E.enoughSamples(mk(0)) === false);
  });

  await t('7. pastRetention 保留期（:78-80 复用 isExpired）', () => {
    const now = new Date();
    check('未来时间 → 未过期', E.pastRetention(new Date(Date.now() + 3600_000)) === false);
    check('过去时间 → 已过期', E.pastRetention(new Date(Date.now() - 3600_000)) === true);
    check('恰好等于当前时刻 → 已过期（<= 语义，:68 e<=n）', E.pastRetention(now) === true);
    check('一毫秒后 → 未过期', E.pastRetention(new Date(Date.now() + 1)) === false);
    check('非法日期串 → 已过期（fail-closed）', E.pastRetention(new Date('not-a-date')) === true);
    check('null → 已过期', E.pastRetention(null) === true);
    check('字符串入参被接受', E.pastRetention(new Date(Date.now() - 1000).toISOString()) === true);
  });

  await t('8. summarizeForLongTerm 长期摘要脱敏', () => {
    const r = E.assembleEvidence({ signals: SIG, context: { text: 'password: hunter2', toolCalls: [] }, baseline: { ...BASE, metrics: { errorRate: 0.125, successRate: 0.875 } }, history: [], currentVersion: 5, relatedChanges: 3 });
    const sum = E.summarizeForLongTerm(r.bundle!);
    check('摘要为字符串', typeof sum === 'string' && sum.length > 0);
    check('摘要可 JSON.parse（结构化）', (() => { try { const o = JSON.parse(sum); return typeof o === 'object' && o !== null; } catch { return false; } })());
    const o = JSON.parse(sum);
    check('摘要只含 signalType 列表，不含 detail 原文', Array.isArray(o.signals) && o.signals[0] === 'db_connection_failed' && !sum.includes('连接串'));
    check('摘要不含 raw 字段内容', !sum.includes('原始对话含'));
    check('摘要不含上下文原文（contextSummary 不入长期摘要）', !sum.includes('hunter2') && !sum.includes('[REDACTED'));
    check('摘要含 samples/metrics/currentVersion/relatedChanges', o.samples === 42 && typeof o.metrics === 'string' && o.currentVersion === 5 && o.relatedChanges === 3);
    check('metrics 数值 toFixed(4) 序列化', o.metrics.includes('errorRate=0.1250'));
    check('baselineWindowHours 透传', o.baselineWindowHours === 24);
  });

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
