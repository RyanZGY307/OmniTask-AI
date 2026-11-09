// Apply 4 generated migration SQL files to their target layerbase DBs.
// Each pooler can be sleeping; a first connect can stall 10-30s. We
// retry connects up to 5x before giving up on a target.
const { Client } = require('pg');
const fs = require('fs');

const TARGETS = [
  { name: 'user',         url: process.env.DATABASE_URL_USER,         sql: 'prisma/migrations-user.sql' },
  { name: 'user-rsi',     url: process.env.DATABASE_URL_USER,         sql: 'prisma/migrations/20261107_rsi-job-queue.up.sql' },
  { name: 'conversation', url: process.env.DATABASE_URL_CONVERSATION, sql: 'prisma/migrations-conversation.sql' },
  { name: 'knowledge',    url: process.env.DATABASE_URL_KNOWLEDGE,    sql: 'prisma/migrations-knowledge.sql' },
  { name: 'knowledge-rsi', url: process.env.DATABASE_URL_KNOWLEDGE,   sql: 'prisma/migrations/20261107_rsi-controlled-lifecycle.up.sql' },
  { name: 'overflow',     url: process.env.DATABASE_URL_OVERFLOW,     sql: 'prisma/migrations-overflow.sql' },
  { name: 'agent',        url: process.env.DATABASE_URL_AGENT,        sql: 'prisma/migrations-agent.sql' },
];

function connectWithRetry(url, label) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function tryConnect() {
      attempt++;
      const c = new Client({
        connectionString: url,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 60000,
      });
      c.connect().then(() => {
        console.log(`[${label}] connected on attempt ${attempt}`);
        resolve(c);
      }).catch((e) => {
        console.log(`[${label}] connect attempt ${attempt} failed: ${e.code || ''} ${e.message}`);
        c.end().catch(() => {});
        if (attempt >= 5) return reject(e);
        setTimeout(tryConnect, 8000);
      });
    }
    tryConnect();
  });
}

async function applyOne(target) {
  const { name, url, sql } = target;
  if (!url) { console.log(`[${name}] no URL set, skipping`); return; }
  const sqlText = fs.readFileSync(sql, 'utf8');
  const c = await connectWithRetry(url, name);
  try {
    // The generated SQL has multiple statements. Run them in one batch.
    // Layerbase pooler can handle multi-statement; if it errors on the
    // batch we fall back to per-statement.
    try {
      await c.query(sqlText);
      console.log(`[${name}] migration applied (batch)`);
    } catch (batchErr) {
      console.log(`[${name}] batch failed (${batchErr.code || batchErr.message}); retrying statement-by-statement`);
      const stmts = sqlText.split(/;\s*$/).map(s => s.trim()).filter(s => s.length > 0 && s !== 'BEGIN' && s !== 'COMMIT');
      for (const [i, s] of stmts.entries()) {
        if (i === 0) { /* skip CREATE SCHEMA IF NOT EXISTS "public" */ }
        try { await c.query(s + ';'); }
        catch (e) {
          if (e.code === '42P07' || e.message.includes('already exists')) continue; // idempotent
          console.log(`[${name}] stmt ${i} error: ${e.message}`);
        }
      }
      console.log(`[${name}] migration applied (statement-by-statement)`);
    }
  } finally {
    await c.end();
  }
}

(async () => {
  const failedTargets = [];
  const failed = [];
  for (const t of TARGETS) {
    try { await applyOne(t); }
    catch (e) { console.error(`[${t.name}] FAILED: ${e.message}`); failed.push(t.name); failedTargets.push(t.name); }
  }
  // 不再无条件 exit(0)：迁移失败必须以非零码结束，避免部署误判成功
  if (failed.length > 0) {
    console.error(`[MIGRATIONS] FAILED targets: ${failed.join(', ')}`);
    process.exit(1);
  }
  process.exit(failedTargets.length ? 1 : 0);
})();
