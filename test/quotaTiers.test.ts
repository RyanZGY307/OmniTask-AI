// ================================================================
// 三级额度与并发限制 — 纯逻辑回归（无数据库、无网络、无真实 API）
//
// 口径（与前后端共用同一条规则文本）：
//   '-' / 空 / 纯空白        → 无限制
//   纯正整数                 → 生效额度
//   其他任何值（含 NaN/非数字
//   字符串/负数/小数/带单位）→ 抛错，绝不静默变成 0=无限
// ================================================================

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

import {
  parseLimitValue,
  parseRateLimitBlock,
  parseTpdBehavior,
  emptyBlock,
  isUnlimitedBlock,
} from '../src/services/rateLimitParse';
import {
  tryAcquire,
  release,
  acquireAll,
  statusOf,
  ensureApiScope,
  ensureCarrierScope,
  ensureModelScope,
  dropApiScope,
  dropCarrierScope,
  dropModelScope,
  windowTz,
  msUntilNextWindowDay,
  currentWindowState,
} from '../src/services/rateLimiter';
import {
  QUOTA_SWITCHABLE,
  NON_SWITCHABLE,
  isQuotaSwitchable,
  nonSwitchableCode,
} from '../src/services/quotaReason';
import {
  activeLeaseKeys,
  acquireConcurrency,
  releaseLease,
  reclaimExpiredLeases,
  type LeaseRequest,
} from '../src/services/concurrencyLease';

// 全部走进程内降级路径，避免测试依赖数据库
process.env.RATE_CONCURRENCY = 'memory';
process.env.RATE_WINDOW_TZ = 'Asia/Shanghai';

const freshState = (): WindowState => currentWindowState();

console.log('\n[1] "-" / 空 / 非法字符 三态解析');
{
  check("'-' → 无限制", parseLimitValue('rpm', '-') === null);
  check('空串 → 无限制', parseLimitValue('rpm', '') === null);
  check('纯空白 → 无限制', parseLimitValue('rpm', '   ') === null);
  check('undefined → 无限制', parseLimitValue('rpm', undefined) === null);
  check('null → 无限制', parseLimitValue('rpm', null) === null);
  check('纯数字字符串 → 生效', parseLimitValue('rpm', '60') === 60);
  check('number → 生效', parseLimitValue('rpm', 60) === 60);
  check('"abc" 抛错', throws(() => parseLimitValue('rpm', 'abc')));
  check('"12x" 抛错', throws(() => parseLimitValue('rpm', '12x')));
  check('"-5" 抛错（负数是无效值，不是无限制）', throws(() => parseLimitValue('rpm', '-5')));
  check('1.5 抛错（小数不是有效 RPM）', throws(() => parseLimitValue('rpm', 1.5)));
  check('NaN 抛错', throws(() => parseLimitValue('rpm', NaN)));
  check('Infinity 抛错', throws(() => parseLimitValue('rpm', Infinity)));
  check('对象抛错', throws(() => parseLimitValue('rpm', {} as any)));
  check('数组抛错', throws(() => parseLimitValue('rpm', [] as any)));

  check("block 内嵌无效 maxParallel → parseRateLimitBlock 抛错", throws(() => parseRateLimitBlock({ rpm: '-', tpm: '', rpd: '100', maxParallel: 'abc' })));
  const b = parseRateLimitBlock({ rpm: '-', tpm: '', rpd: '100', maxParallel: '3', tpdBehavior: 'block' });
  check('block 混合解析：rpm 无限', b.rpm === null);
  check('block 混合解析：tpm 无限', b.tpm === null);
  check('block 混合解析：rpd=100', b.rpd === 100);
  check('空 block 全无限', isUnlimitedBlock(emptyBlock()));
}

console.log('\n[2] TPD 行为枚举');
{
  check("'block' 保留", parseTpdBehavior('block') === 'block');
  check("'limitRpm' 保留", parseTpdBehavior('limitRpm') === 'limitRpm');
  check('空/undefined 回落 block', parseTpdBehavior('') === 'block' && parseTpdBehavior(undefined) === 'block');
  check('任意非法值抛错（不静默回落）', throws(() => parseTpdBehavior('nonsense')));
}

console.log('\n[3] TPD 两种策略执行');
{
  // block：当日 token 用尽 → 直接拒绝
  const s1 = freshState();
  s1.dayTokens = 1000;
  const r1 = tryAcquire(s1, { limit: { tpd: 1000, tpdBehavior: 'block' } });
  check('TPD block：用尽即拒绝', r1.allowed === false && r1.reason === 'blocked');

  // block：未用尽 → 放行
  const s2 = freshState();
  const r2 = tryAcquire(s2, { limit: { tpd: 1000, tpdBehavior: 'block' }, estTokens: 100 });
  check('TPD block：未用尽放行', r2.allowed === true);

  // limitRpm：用尽后降速放行（不拒绝）
  const s3 = freshState();
  s3.dayTokens = 1000;
  const r3 = tryAcquire(s3, { limit: { tpd: 1000, tpdBehavior: 'limitRpm', tpdLimitRpm: 5 } });
  check('TPD limitRpm：用尽仍放行（降速）', r3.allowed === true);
  check('TPD limitRpm：生效 RPM 被压到 tpdLimitRpm', r3.effectiveRpm === 5);
  let last: any = { allowed: true };
  for (let i = 0; i < 5; i++) last = tryAcquire(s3, { limit: { tpd: 1000, tpdBehavior: 'limitRpm', tpdLimitRpm: 5 } });
  check('TPD limitRpm：降速到 5 次后第 6 次拒', last.allowed === false);
}

console.log('\n[4] RPM / RPD / TPM 与并行占用');
{
  const s = freshState();
  const limit = { rpm: 2, rpd: 20 };
  const a = tryAcquire(s, { limit });
  const b = tryAcquire(s, { limit });
  const c = tryAcquire(s, { limit });
  check('RPM=2：前两个放行', a.allowed && b.allowed);
  check('RPM=2：第三个被拒', c.allowed === false && c.reason === 'rate_limited');
  release(s);
  const d = tryAcquire(s, { limit });
  check('release 后并行恢复但 RPM 仍受限', d.allowed === false);

  const p = freshState();
  const pl = { maxParallel: 2 };
  const p1 = tryAcquire(p, { limit: pl });
  const p2 = tryAcquire(p, { limit: pl });
  const p3 = tryAcquire(p, { limit: pl });
  check('maxParallel=2：第三个拒（max_parallel）', p3.allowed === false && p3.reason === 'max_parallel');
  check('并发满 max_parallel 不可切换', isQuotaSwitchable(p3.reason) === false);
  release(p); release(p);
  const p4 = tryAcquire(p, { limit: pl });
  check('并行释放后可再入', p4.allowed === true);

  const t = freshState();
  t.tokMin.count = 900;
  const tr = tryAcquire(t, { limit: { tpm: 1000 }, estTokens: 200 });
  check('TPM 超限拒', tr.allowed === false && tr.reason === 'rate_limited');

  const rd = freshState();
  rd.dayReq = 10;
  const rdr = tryAcquire(rd, { limit: { rpd: 10 } });
  check('RPD 用尽拒', rdr.allowed === false && rdr.reason === 'blocked');
  check('额度类原因 rate_limited 可切换', isQuotaSwitchable(rdr.reason) === true);
}

console.log('\n[5] 三级同时生效且互不覆盖');
{
  const api = freshState();
  const carrier = freshState();
  const model = freshState();
  // 运营商层先打满：即使 API 层与模型层都空，也必须整体拒绝
  carrier.dayReq = 10;
  const gates = {
    api: { state: api, limit: { rpd: 100 } },
    carrier: { state: carrier, limit: { rpd: 10 } },
    model: { state: model, limit: { rpd: 100 } },
  };
  const g1 = acquireAll(gates);
  check('运营商额度打满 → 整体拒', g1.ok === false);
  check('整体拒返回原因', typeof g1.reason === 'string');

  // 三层都放行
  const api2 = freshState(), carrier2 = freshState(), model2 = freshState();
  const g2 = acquireAll({
    api: { state: api2, limit: { rpd: 100, rpm: 10 } },
    carrier: { state: carrier2, limit: { rpd: 100 } },
    model: { state: model2, limit: { rpd: 100 } },
  });
  check('三层均未达限 → 放行', g2.ok === true);
  check('放行返回三个 release', g2.released.length === 3);

  // 第二层拒 → 第一层已回滚
  const a3 = freshState(), c3 = freshState(), m3 = freshState();
  a3.parallel = 0;
  c3.reqMin.count = 999;
  const g3 = acquireAll({
    api: { state: a3, limit: { maxParallel: 1 } },
    carrier: { state: c3, limit: { rpm: 1 } },
    model: { state: m3, limit: { rpm: 1 } },
  });
  check('第二层拒 → 整体拒', g3.ok === false);
  check('第一层并行已回滚（api.parallel 归 0）', a3.parallel === 0);
}

console.log('\n[6] 切换边界：只有数据额度类可触发切换');
{
  const switchable: string[] = [...QUOTA_SWITCHABLE];
  const non: string[] = [...NON_SWITCHABLE];
  for (const r of switchable) check(`额度类 ${r} → 可切换`, isQuotaSwitchable(r));
  for (const r of non) check(`非额度类 ${r} → 不可切换`, isQuotaSwitchable(r) === false);
  check('max_parallel 有稳定错误码', nonSwitchableCode('max_parallel') === 'max_parallel');
  check('undefined 回落 unknown_block', nonSwitchableCode(undefined) === 'unknown_block');
}

(async () => {
console.log('\n[7] 并发 Lease：多级同时占 + 释放 + 过期回收 + 幂等');
{
  const req: LeaseRequest = {
    provider: 'openai', tier: 'PRO', apiKey: 'sk-abc', modelKey: 'gpt-4o',
    apiMax: 1, carrierMax: 1, modelMax: 1, ttlMs: 60_000,
  };
  const keys = activeLeaseKeys(req);
  check('三级均有限额 → 3 个 key', keys.length === 3);

  // 顺序占：每次只拿一个（因为上限都是 1）
  const first = await acquireConcurrency({ ...req });
  check('首次占用成功', first.ok === true && first.handles.length === 3);

  const second = await acquireConcurrency({ ...req, apiMax: 1, carrierMax: 1, modelMax: 1 });
  check('上限 1 → 第二次被拒', second.ok === false);
  check('拒绝给出层级', second.deniedScope === 'api' || second.deniedScope === 'carrier' || second.deniedScope === 'model');
  check('并发满不可切换', isQuotaSwitchable(second.reason ?? '') === false);

  for (const h of first.handles) await h.release();
  const third = await acquireConcurrency({ ...req });
  check('全部释放后可再占', third.ok === true && third.handles.length === 3);

  // 幂等释放：重复释放不影响
  const released1 = await releaseLease(keys[0].key);
  const released2 = await releaseLease(keys[0].key);
  check('release 幂等（已释放仍 true）', released1 === true && released2 === true);
  for (const h of third.handles) await h.release();

  // 过期回收：注入已过期的租约
  const expiredReq: LeaseRequest = {
    provider: 'expiretest', tier: 'FREE', apiKey: 'k', modelKey: 'm',
    apiMax: 1, ttlMs: -1,
  };
  const exp = await acquireConcurrency(expiredReq);
  check('负 TTL 的租约可创建', exp.ok === true);
  const reclaimed = await reclaimExpiredLeases();
  check('过期回收返回条数（>=0）', reclaimed >= 0);
  for (const h of exp.handles) await h.release();
}

console.log('\n[8] 无限级不占位（避免把无限制当 0 处理成永远拒绝）');
{
  const r = await acquireConcurrency({
    provider: 'p', tier: 'FREE', apiKey: 'k', modelKey: 'm',
    apiMax: null, carrierMax: null, modelMax: null,
  });
  check('三级均无限 → 直接放行不建租约', r.ok === true && r.handles.length === 0);
}

console.log('\n[9] 窗口时区');
{
  check('默认 Asia/Shanghai', windowTz() === 'Asia/Shanghai');
  const ms = msUntilNextWindowDay(Date.UTC(2026, 10, 7, 15, 30)); // 2026-11-07 15:30 UTC = 23:30 CST
  check('23:30 距次日零点约 30 分钟', ms > 29 * 60_000 && ms <= 31 * 60_000);
  const ms2 = msUntilNextWindowDay(Date.UTC(2026, 10, 7, 16, 30)); // 00:30 CST
  check('00:30 距次日零点约 23.5 小时', ms2 > 23 * 3600_000 && ms2 < 24 * 3600_000);
}

console.log('\n[10] 状态判定 statusOf 不抛错');
{
  const s = freshState();
  check('无限额度 → ok', statusOf(s, undefined) === 'ok');
  s.parallel = 4;
  check('并行 4/5 → hot（≥80%）', statusOf(s, { maxParallel: 5 }) === 'hot');
  s.parallel = 5;
  check('并行 5/5 → blocked', statusOf(s, { maxParallel: 5 }) === 'blocked');
  s.parallel = 6;
  check('并行超限 → blocked', statusOf(s, { maxParallel: 5 }) === 'blocked');
}

console.log('\n[11] scope 生命周期（无泄漏）');
{
  const a = ensureApiScope('cleanup', 'FREE', 'k1');
  tryAcquire(a, { limit: { rpm: 1 } });
  dropApiScope('cleanup', 'FREE', 'k1');
  const a2 = ensureApiScope('cleanup', 'FREE', 'k1');
  check('dropApiScope 后重建为空窗', a2.reqMin.count === 0 && a2.parallel === 0);

  const c = ensureCarrierScope('cleanupcarrier', 'PRO');
  tryAcquire(c, { limit: { rpd: 1 } });
  dropCarrierScope('cleanupcarrier', 'PRO');
  const c2 = ensureCarrierScope('cleanupcarrier', 'PRO');
  check('dropCarrierScope 后重建为空窗', c2.dayReq === 0);

  const m = ensureModelScope('cleanup/model');
  tryAcquire(m, { limit: { rpd: 1 } });
  dropModelScope('cleanup/model');
  const m2 = ensureModelScope('cleanup/model');
  check('dropModelScope 后重建为空窗', m2.dayReq === 0);
}

console.log('\n================ 结果 ================');
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
})();
