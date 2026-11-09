/**
 * RSI 迁移执行器（幂等 + 前置校验 + 失败不吞 + 逐条事务外提示）。
 * 用法：
 *   DATABASE_URL_KNOWLEDGE=postgres://... DATABASE_URL_USER=postgres://... \
 *   node scripts/applyRsiMigrations.js            # 预检+应用
 *   node scripts/applyRsiMigrations.js --check    # 只预检
 *   node scripts/applyRsiMigrations.js --down     # 执行下行（需 RESET_CONFIRM=y）
 * 与 applyMigrations.js 的区别：不吞错误、不 process.exit(0) 掩盖失败、逐条报告。
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const UP_FILES = [
  { file: '20261107_rsi-controlled-lifecycle.up.sql', env: 'DATABASE_URL_KNOWLEDGE' },
  { file: '20261107_rsi-job-queue.up.sql', env: 'DATABASE_URL_USER' },
];
const DOWN_FILES = UP_FILES.map((m) => ({ file: m.file.replace('.up.sql', '.down.sql'), env: m.env }));

async function connect(url) {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

async function run(client, sql) {
  const res = await client.query(sql);
  return res.command;
}

(async () => {
  const mode = process.argv[2] || '--up';
  // 真·只读检查：不发任何 DDL，只查 pg_tables / information_schema。
  if (mode === '--check') {
    (async () => {
      let failures = 0;
      for (const t of UP_FILES) {
        const url = process.env[t.env];
        if (!url) { console.log(`SKIP ${t.file}: 缺少环境变量 ${t.env}`); continue; }
        const c = await connect(url);
        try {
          const cnt = await c.query(
            `select count(*)::int as n from pg_tables where schemaname='public' and tablename in ('ManagedAsset','AssetVersion','ChangeRequest','SystemPause','RsiJob','ConcurrencyLease','QuotaSwitchLog','RsiProviderConfig','RsiQuotaSwitchLog')`
          );
          console.log(`CHECK ${t.env} ${t.file}: 已存在 ${cnt.rows[0].n} 张目标表（未执行任何 DDL）`);
        } catch (e) {
          console.error(`CHECK-FAIL ${t.env}: ${e.message}`); failures++;
        } finally { await c.end().catch(() => undefined); }
      }
      process.exit(failures > 0 ? 1 : 0);
    })().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
    return;
  }
  const targets = mode === '--down' ? DOWN_FILES : UP_FILES;
  if (mode === '--down' && process.env.RESET_CONFIRM !== 'y') {
    console.error('下行迁移会删除 RSI 四张表与任务表，需 RESET_CONFIRM=y 确认');
    process.exit(2);
  }
  let hardFail = 0;
  for (const t of targets) {
    const url = process.env[t.env];
    if (!url) { console.error(`SKIP ${t.file}: 缺少环境变量 ${t.env}（不视为失败）`); continue; }
    const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations', t.file), 'utf8');
    const statements = sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
    const c = await connect(url);
    try {
      try {
        const cnt = await c.query(`select count(*)::int as n from pg_tables where schemaname='public' and tablename in ('ManagedAsset','AssetVersion','ChangeRequest','SystemPause','RsiJob')`);
        console.log(`[precheck] ${t.env}: 已存在 RSI 表 ${cnt.rows[0].n} 张（迁移为幂等）`);
      } catch { /* 预检失败不阻断，正式执行会报错 */ }
      for (const st of statements) {
        try { await run(c, st + ';'); } catch (e) {
          if (e.code === '42P07' || /already exists/i.test(String(e.message))) {
            console.log(`  OK(已存在) ${st.slice(0, 60).replace(/\s+/g, ' ')}...`);
          } else {
            console.error(`  FAIL ${st.slice(0, 80).replace(/\s+/g, ' ')}\n       ${e.message}`);
            hardFail++;
          }
        }
      }
    } finally { await c.end().catch(() => {}); }
  }
  console.log(hardFail ? `\n失败 ${hardFail} 条` : '\n全部语句执行完毕');
  process.exit(hardFail ? 1 : 0);
})().catch((e) => { console.error('迁移器异常:', e.message); process.exit(1); });
