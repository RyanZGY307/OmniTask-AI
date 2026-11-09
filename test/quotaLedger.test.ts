/**
 * 跨实例额度账本 —— 纯逻辑单测（不连库）。
 * 覆盖：窗口键/时区、限额归一、结算差额、保守计费、预留状态机、过期判定。
 * 多实例原子抢占属 PG 行为，见 quotaLedgerPg.integration.test.ts（需真实 PG，否则 BLOCKED）。
 */
process.env.RATE_WINDOW_TZ = process.env.RATE_WINDOW_TZ || 'Asia/Shanghai';

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

import {
  minuteWindowKey, dayWindowKey, scopeKeyOf, normalizeLimits, settlementDelta,
  conservativeTokens, RESERVATION_TRANSITIONS, canReservationTransition,
  isReservationExpired,
} from '../src/services/quotaLedger';

// ---- 1. 窗口键与时区 ----
{
  const now = Date.UTC(2026, 10, 7, 16, 30, 0); // 2026-11-08 00:30 Asia/Shanghai（对齐整分，避免跨分钟误判）
  check('分钟窗口键按 60s 归并', minuteWindowKey(now) === minuteWindowKey(now + 59_000));
  check('跨分钟窗口键不同', minuteWindowKey(now) !== minuteWindowKey(now + 60_000));
  check('半分钟前不越界（原用例错误：30s+59s 会跨分）', minuteWindowKey(Date.UTC(2026,10,7,16,29,59)) !== minuteWindowKey(now));
  check('日窗口键按 Asia/Shanghai 落 2026-11-08', dayWindowKey(now, 'Asia/Shanghai') === '2026-11-08');
  check('UTC 下同一时刻仍是 11-07', dayWindowKey(now, 'UTC') === '2026-11-07');
  check('时区不可用回退 UTC 不抛错', typeof dayWindowKey(now, 'Not/AZone') === 'string');
  const s = { level: 'api' as const, scopeId: 'openai:FREE:abcd1234' };
  check('scopeKey 含层级与主体', scopeKeyOf(s, 'minute', now).startsWith('api:openai:FREE:abcd1234:m'));
  check('同层同窗同 key', scopeKeyOf(s, 'minute', now) === scopeKeyOf(s, 'minute', now + 1000));
  check('carrier 与 api 同主体不同 key', scopeKeyOf({ level: 'carrier', scopeId: 'openai:FREE' }, 'minute', now) !== scopeKeyOf(s, 'minute', now));
}

// ---- 2. 限额归一：'-'/空=0=无限，非法抛错 ----
{
  check("'-' → 0（无限）", normalizeLimits({ rpm: '-' }).rpm === 0);
  check('空 → 0（无限）', normalizeLimits({ rpm: '' }).rpm === 0);
  check('undefined → 0', normalizeLimits(undefined).rpm === 0);
  check('正整数生效', normalizeLimits({ rpm: '60' }).rpm === 60);
  let threw = false;
  try { normalizeLimits({ rpm: '12x' }); } catch { threw = true; }
  check('非法字符抛错（不静默变无限）', threw);
  let threw2 = false;
  try { normalizeLimits({ tpm: '-5' }); } catch { threw2 = true; }
  check('负数抛错', threw2);
}

// ---- 3. 结算差额：多退少补，不重复计 ----
{
  check('实际=预估 → 差额 0', settlementDelta(100, 100) === 0);
  check('实际>预估 → 补扣', settlementDelta(100, 180) === 80);
  check('实际<预估 → 退还', settlementDelta(100, 40) === -60);
  check('负值夹到 0', settlementDelta(0, 0) === 0);
  check('小数向下取整', settlementDelta(10.7, 3.2) === -7);
}

// ---- 4. 保守计费（uncertain 不得假装没消耗）----
{
  check('缺 actual → 全额计入', conservativeTokens(500) === 500);
  check('null → 全额计入', conservativeTokens(500, null) === 500);
  check('actual 更小仍按 actual（已确认部分）', conservativeTokens(500, 120) === 120);
  check('actual 为 0 表示确认零消耗', conservativeTokens(500, 0) === 0);
  check('负 actual 夹 0', conservativeTokens(500, -9) === 0);
}

// ---- 5. 预留状态机 ----
{
  check('reserved 可迁 committed', canReservationTransition('reserved', 'committed'));
  check('reserved 可迁 released', canReservationTransition('reserved', 'released'));
  check('reserved 可迁 expired', canReservationTransition('reserved', 'expired'));
  check('reserved 可迁 uncertain', canReservationTransition('reserved', 'uncertain'));
  check('uncertain 可补结算', canReservationTransition('uncertain', 'committed'));
  check('committed 是终态', !canReservationTransition('committed', 'released'));
  check('released 是终态', !canReservationTransition('released', 'committed'));
  check('expired 是终态', !canReservationTransition('expired', 'committed'));
  check('非法迁移（reserved→reserved）被拒', !canReservationTransition('reserved', 'reserved'));
  check('五态齐全', Object.keys(RESERVATION_TRANSITIONS).length === 5);
}

// ---- 6. 租约过期判定 ----
{
  const t0 = 1_000_000;
  check('未到期', !isReservationExpired(t0, 120_000, t0 + 119_000));
  check('已到期', isReservationExpired(t0, 120_000, t0 + 120_001));
  check('ttl=0 立即过期', isReservationExpired(t0, 0, t0 + 1));
}

console.log('\n结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail > 0 ? 1 : 0);
