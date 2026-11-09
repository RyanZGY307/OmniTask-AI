#!/usr/bin/env node
// 第三级额度体系迁移执行器（幂等 + 诚实退出码 + --check / --down）
//   node scripts/applyRateLimitMigrations.js --check     只读检查，不执行
//   node scripts/applyRateLimitMigrations.js             执行 up
//   node scripts/applyRateLimitMigrations.js --down      执行 down（需 RESET_CONFIRM=y）
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DIR = path.join(__dirname, '..', 'prisma', 'migrations');
const FILES = [
  '20261108_rate-limit-concurrency.up.sql',
  '20261108_rsi-provider-config.up.sql',
];
const DOWN_FILES = [
  '20261108_rsi-provider-config.down.sql',
  '20261108_rate-limit-concurrency.down.sql',
];

// 跨库归属：ConcurrencyLease/QuotaSwitchLog 在 user 库，RsiProviderConfig/RsiQuotaSwitchLog 在 knowledge 库。
// 原先两个文件对两个库各跑一遍，导致 RsiProviderConfig 被建进 user 库、ConcurrencyLease 被建进 knowledge 库（孤儿表）。
const TARGETS = [
  { name: 'user', env: 'DATABASE_URL_USER', files: ['20261108_rate-limit-concurrency.up.sql', '20261108_quota-ledger-cross-instance.up.sql'], down: ['20261108_quota-ledger-cross-instance.down.sql', '20261108_rate-limit-concurrency.down.sql'] },
  { name: 'knowledge', env: 'DATABASE_URL_KNOWLEDGE', files: ['20261108_rsi-provider-config.up.sql'], down: ['20261108_rsi-provider-config.down.sql'] },
];

function load(p) { return fs.readFileSync(path.join(DIR, p), 'utf8'); }
function needed(name, upSql) {
  // 粗判：表是否已存在（content 的 CREATE TABLE IF NOT EXISTS 仍是幂等的）
  return upSql;
}

(async () => {
  const mode = process.argv[2] || 'up';
  // 真·只读检查（原注释声称只读但实际执行 up，与本任务书「不得伪造运行结果」冲突，已修正）
  if (mode === '--check') {
    let failures = 0;
    for (const t of TARGETS) {
      const url = process.env[t.env];
      if (!url) { console.log(`SKIP ${t.name}: 未提供 ${t.env}`); continue; }
      const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
      try {
        await c.connect();
        const r = await c.query(`select count(*)::int as n from pg_tables where schemaname='public' and tablename in ('ConcurrencyLease','QuotaSwitchLog','RsiProviderConfig','RsiQuotaSwitchLog')`);
        console.log(`CHECK ${t.name}: 已存在 ${r.rows[0].n} 张目标表（未执行任何 DDL）`);
      } catch (e) { console.error(`CHECK-FAIL ${t.name}: ${e.message}`); failures++; }
      finally { await c.end().catch(() => undefined); }
    }
    process.exit(failures > 0 ? 1 : 0);
  }
  if (mode === '--down' && process.env.RESET_CONFIRM !== 'y') {
    console.error('拒绝执行 down：需 RESET_CONFIRM=y');
    process.exit(2);
  }
  const files = mode === '--down' ? t.down : t.files;
  let failures = 0;
  for (const t of TARGETS) {
    const url = process.env[t.env];
    if (!url) { console.log(`SKIP ${t.name}: 未提供 ${t.env}`); continue; }
    const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
    } catch (e) {
      console.error(`CONN-FAIL ${t.name}: ${e.message}`);
      failures++;
      continue;
    }
    for (const f of files) {
      const sql = load(f);
      try {
        await client.query(sql);
        console.log(`OK ${t.name} ${f}`);
      } catch (e) {
        console.error(`FAIL ${t.name} ${f}: ${e.message}`);
        failures++;
      }
    }
    await client.end().catch(() => undefined);
  }
  if (failures > 0) { console.error(`共 ${failures} 项失败`); process.exit(1); }
  console.log('全部完成');
})().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
