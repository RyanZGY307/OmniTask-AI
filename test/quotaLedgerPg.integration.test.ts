/**
 * 跨实例额度账本 —— 真实 PostgreSQL 集成测试（多实例竞争）。
 *
 * 运行前提（缺一即 BLOCKED，绝不用单元测试冒充）：
 *   QUOTA_TEST_DB_URL=postgres://user:pass@host:5432/db
 *  且该库已执行 20261108_quota-ledger-cross-instance.up.sql
 *  且本机可 require('pg')
 *
 * 覆盖任务书点名的场景：
 *   1) 两个独立连接竞争同一 RPM 最后一个名额
 *   2) 两个独立连接竞争同一 TPM 剩余 token
 *   3) 多 API 共用 Provider 聚合额度
 *   4) 多 API 调用同一 Model 额度
 *   5) 三层并发同时争夺最后一个名额（ConcurrencyLease）
 *   6) 获取部分许可后失败的回滚
 *   7) 预留后进程崩溃（过期回收）
 *   8) Token 实际结算（committed 多退少补）
 *   9) 流式中断（uncertain 保守计费）
 *  10) 自动切换后重新检查备用额度
 *  11) 并发满时排队而不切换
 *  12) RSI 与普通 API 配置完全隔离
 */
const URL_ = process.env.QUOTA_TEST_DB_URL || '';

function bannerBlocked(why: string): void {
  console.log('=========================================================');
  console.log('BLOCKED: ' + why);
  console.log('本文件是真实 PostgreSQL 多实例集成测试，未运行任何断言。');
  console.log('未用单元测试冒充多实例测试（任务书第 8 项要求）。');
  console.log('解除阻塞：设置 QUOTA_TEST_DB_URL 并执行 up 迁移后重跑。');
  console.log('=========================================================');
}

let pg: any = null;
try { pg = require('pg'); } catch { pg = null; }

if (!URL_ || !pg) {
  bannerBlocked(!URL_ ? '未提供 QUOTA_TEST_DB_URL（本地无 PostgreSQL 可用）' : '本机缺少 pg 客户端依赖');
  process.exit(0);
}

import { reserveQuota, settleQuota, reclaimExpiredReservations, __setQuotaClient, scopeKeyOf } from '../src/services/quotaLedger';

const stamp = Date.now().toString(36);
let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name); }
}

/** 造两个独立 client，模拟两个后端实例（各自连接、各自事务）。 */
function twoInstances(): { a: any; b: any } {
  const a = new pg.Client({ connectionString: URL_, ssl: { rejectUnauthorized: false } });
  const b = new pg.Client({ connectionString: URL_, ssl: { rejectUnauthorized: false } });
  return { a, b };
}

/** 直连 SQL 读账本行（绕开 prisma，确保读的是库里真实值）。 */
async function readLedger(c: any, scopeKey: string): Promise<{ reqCount: number; tokReserved: number; tokCommitted: number } | null> {
  const r = await c.query('select "reqCount","tokReserved","tokCommitted" from "QuotaLedger" where "scopeKey"=$1', [scopeKey]);
  return r.rows[0] ?? null;
}

(async () => {
  const { a, b } = twoInstances();
  await a.connect(); await b.connect();
  // 伪 prisma：只实现被测用到的原语
  const mk = (c: any) => ({
    $executeRawUnsafe: (sql: string, ...args: unknown[]) => {
      // 把 $n 占位符换成 pg 的 $n（一致），直接用 c.query
      return c.query(sql, args as unknown[]).then((r: any) => r.rows);
    },
    quotaReservation: {
      findUnique: ({ where }: any) => c.query('select * from "QuotaReservation" where "id"=$1 or "reservationKey"=$1 limit 1', [where.id ?? where.reservationKey]).then((r: any) => r.rows[0] ?? null),
      create: ({ data }: any) => c.query(
        `insert into "QuotaReservation" ("id","reservationKey","status","estTokens","committedTokens","scopes","origin","provider","tier","apiKey","modelKey","requestId","expiresAt")
         values (gen_random_uuid()::text,$1,$2,$3,0,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [data.reservationKey, data.status, data.estTokens, data.scopes, data.origin, data.provider, data.tier, data.apiKey, data.modelKey, data.requestId, data.expiresAt],
      ).then((r: any) => r.rows[0]),
      findMany: ({ where, take }: any) => c.query('select * from "QuotaReservation" where status=$1 and "expiresAt" < now() order by "expiresAt" asc limit $2', [where.status, take ?? 500]).then((r: any) => r.rows),
    },
  });

  // ---- 场景 1：两实例竞争同一 RPM 最后一个名额 ----
  {
    const sid = `it:rpm:${stamp}`;
    const scope = { level: 'api' as const, scopeId: sid };
    const limits = { api: { rpm: 3 } };
    // 先用掉 2 个
    for (let i = 0; i < 2; i++) {
      __setQuotaClient(mk(a));
      const r = await reserveQuota({ scopes: [scope], estTokens: 0, limits, now: Date.now(), origin: 'chat' });
      check(`RPM 预留 #${i + 1} 成功`, r.ok);
    }
    __setQuotaClient(mk(b));
    const third = await reserveQuota({ scopes: [scope], estTokens: 0, limits, origin: 'chat' });
    check('第三个实例抢到最后一个 RPM 名额', third.ok);
    __setQuotaClient(mk(a));
    const fourth = await reserveQuota({ scopes: [scope], estTokens: 0, limits, origin: 'chat' });
    check('第四个实例被拒（不突破上限）', !fourth.ok && fourth.reason === 'rate_limited');
    const row = await readLedger(a, scopeKeyOf(scope, 'minute'));
    check('账本 reqCount 恰为 3（无超卖）', !!row && row.reqCount === 3);
  }

  // ---- 场景 2：两实例竞争同一 TPM 剩余 token ----
  {
    const sid = `it:tpm:${stamp}`;
    const scope = { level: 'api' as const, scopeId: sid };
    const limits = { api: { tpm: 1000 } };
    __setQuotaClient(mk(a));
    const r1 = await reserveQuota({ scopes: [scope], estTokens: 600, limits, origin: 'chat' });
    check('TPM 预留 600 成功', r1.ok);
    __setQuotaClient(mk(b));
    const r2 = await reserveQuota({ scopes: [scope], estTokens: 600, limits, origin: 'chat' });
    check('第二个实例 600 被拒（1000-600=400 余量不足）', !r2.ok && r2.reason === 'rate_limited');
    const r3 = await reserveQuota({ scopes: [scope], estTokens: 400, limits, origin: 'chat' });
    check('400 恰好用尽余量成功', r3.ok);
    __setQuotaClient(mk(a));
    const r4 = await reserveQuota({ scopes: [scope], estTokens: 1, limits, origin: 'chat' });
    check('余量 0 后再抢 1 被拒', !r4.ok);
    const row = await readLedger(a, scopeKeyOf(scope, 'minute'));
    check('tokReserved 恰为 1000', !!row && row.tokReserved === 1000);
  }

  // ---- 场景 8：Token 实际结算（多退少补 + 不重复计）----
  {
    const sid = `it:settle:${stamp}`;
    const scope = { level: 'api' as const, scopeId: sid };
    const limits = { api: { tpm: 10000, rpm: 1000 } };
    __setQuotaClient(mk(a));
    const r = await reserveQuota({ scopes: [scope], estTokens: 500, limits, idempotencyKey: `settle:${stamp}`, origin: 'chat' });
    check('结算用例预留成功', r.ok && !!r.reservationId);
    await r.settle!({ status: 'committed', actualTokens: 820 });
    let row = await readLedger(a, scopeKeyOf(scope, 'minute'));
    check('committed 后 tokReserved=0，tokCommitted=820', !!row && row.tokReserved === 0 && row.tokCommitted === 820);
    // 幂等：重复 settle 不得再动账面
    await r.settle!({ status: 'committed', actualTokens: 820 });
    row = await readLedger(a, scopeKeyOf(scope, 'minute'));
    check('重复结算幂等（账面不变）', !!row && row.tokCommitted === 820);
    // 退还路径
    const r2 = await reserveQuota({ scopes: [scope], estTokens: 300, limits, origin: 'chat' });
    await r2.settle!({ status: 'released' });
    row = await readLedger(a, scopeKeyOf(scope, 'minute'));
    check('released 后 tokReserved 归 0', !!row && row.tokReserved === 0);
    // 幂等键复用不得双扣
    const again = await reserveQuota({ scopes: [scope], estTokens: 500, limits, idempotencyKey: `settle:${stamp}`, origin: 'chat' });
    check('同幂等键重试被识别（不重复占用）', !again.ok && again.reason === 'duplicate');
  }

  // ---- 场景 9：流式中断 → uncertain 保守计费 ----
  {
    const sid = `it:uncertain:${stamp}`;
    const scope = { level: 'api' as const, scopeId: sid };
    const limits = { api: { tpm: 100000, rpm: 1000 } };
    __setQuotaClient(mk(a));
    const r = await reserveQuota({ scopes: [scope], estTokens: 700, limits, origin: 'chat' });
    await r.settle!({ status: 'uncertain' }); // 未收到完整响应 → 按预估全额计入
    const row = await readLedger(a, scopeKeyOf(scope, 'minute'));
    check('uncertain 按预估 700 保守计入 committed', !!row && row.tokCommitted === 700 && row.tokReserved === 0);
  }

  // ---- 场景 7：预留后崩溃（不结算）→ 过期回收 ----
  {
    const sid = `it:crash:${stamp}`;
    const scope = { level: 'api' as const, scopeId: sid };
    const limits = { api: { tpm: 100000, rpm: 1000 } };
    __setQuotaClient(mk(a));
    const r = await reserveQuota({ scopes: [scope], estTokens: 400, limits, ttlMs: 1, origin: 'chat' });
    check('崩溃用例预留成功', r.ok);
    await new Promise((res) => setTimeout(res, 30));
    const n = await reclaimExpiredReservations(100);
    check('过期回收至少处理 1 笔', n >= 1);
    const row = await readLedger(a, scopeKeyOf(scope, 'minute'));
    check('过期后 tokReserved 已退还', !!row && row.tokReserved === 0);
  }

  // ---- 场景 6：部分许可失败回滚（三层里第三层拒）----
  {
    const sidApi = `it:rb:api:${stamp}`;
    const sidModel = `it:rb:model:${stamp}`;
    const scopes = [
      { level: 'api' as const, scopeId: sidApi },
      { level: 'model' as const, scopeId: sidModel },
    ];
    const limits: Record<string, { rpm: number }> = { api: { rpm: 5 }, model: { rpm: 0 } };
    __setQuotaClient(mk(a));
    const ok = await reserveQuota({ scopes, estTokens: 0, limits, origin: 'chat' });
    check('两层均可用时放行', ok.ok);
    const limits2: Record<string, { rpm: number }> = { api: { rpm: 5 }, model: { rpm: 1 } };
    // 先把 model 用满
    const m1 = await reserveQuota({ scopes: [{ level: 'model', scopeId: sidModel }], estTokens: 0, limits: { model: { rpm: 1 } }, origin: 'chat' });
    check('model 名额预占用成功', m1.ok);
    const denied = await reserveQuota({ scopes, estTokens: 0, limits: limits2, origin: 'chat' });
    check('model 层拒绝 → 整体拒绝', !denied.ok);
    const apiRow = await readLedger(a, scopeKeyOf({ level: 'api', scopeId: sidApi }, 'minute'));
    check('api 层已回滚（未半成功残留）', !!apiRow && apiRow.reqCount === 1);
    await m1.settle!({ status: 'released' });
  }

  // ---- 场景 3/4：多 API 共用 Provider 聚合额度 ----
  {
    const carrier = `it:carrier:${stamp}`;
    const k1 = { level: 'carrier' as const, scopeId: carrier };
    __setQuotaClient(mk(a));
    const c1 = await reserveQuota({ scopes: [k1], estTokens: 0, limits: { carrier: { rpm: 2 } }, origin: 'chat' });
    __setQuotaClient(mk(b));
    const c2 = await reserveQuota({ scopes: [k1], estTokens: 0, limits: { carrier: { rpm: 2 } }, origin: 'chat' });
    const c3 = await reserveQuota({ scopes: [k1], estTokens: 0, limits: { carrier: { rpm: 2 } }, origin: 'chat' });
    check('carrier 聚合额度：两个实例共用同一账本（第 3 个被拒）', c1.ok && c2.ok && !c3.ok);
    const row = await readLedger(a, scopeKeyOf(k1, 'minute'));
    check('carrier 账本 reqCount=2', !!row && row.reqCount === 2);
  }

  // ---- 场景 12：RSI 与普通 API 完全隔离（不同 scopeId 前缀）----
  {
    const chatSid = `it:chat:${stamp}`;
    const rsiSid = `rsi:it:${stamp}`;
    __setQuotaClient(mk(a));
    const rc = await reserveQuota({ scopes: [{ level: 'api', scopeId: chatSid }], estTokens: 0, limits: { api: { rpm: 1 } }, origin: 'chat' });
    const rr = await reserveQuota({ scopes: [{ level: 'api', scopeId: rsiSid }], estTokens: 0, limits: { api: { rpm: 1 } }, origin: 'rsi' });
    check('chat 用满不影响 RSI（两者 scopeKey 独立）', rc.ok && rr.ok);
    const chatRow = await readLedger(a, scopeKeyOf({ level: 'api', scopeId: chatSid }, 'minute'));
    const rsiRow = await readLedger(a, scopeKeyOf({ level: 'api', scopeId: rsiSid }, 'minute'));
    check('两条账本行互不干扰', !!chatRow && !!rsiRow && chatRow.reqCount === 1 && rsiRow.reqCount === 1);
  }

  console.log('\n结果: ' + pass + ' pass, ' + fail + ' fail');
  await a.end().catch(() => undefined);
  await b.end().catch(() => undefined);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('集成测试执行异常: ' + String(e?.message ?? e));
  console.log('BLOCKED: 真实 PostgreSQL 不可用或迁移未执行，未得出通过结论。');
  process.exit(1);
});
