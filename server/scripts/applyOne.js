const { Client } = require('pg');
const fs = require('fs');
const name = process.argv[2];
const url = process.argv[3];
const sqlFile = process.argv[4];
(async () => {
  const sqlText = fs.readFileSync(sqlFile, 'utf8');
  const c = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 45000,
  });
  let connected = false;
  for (let attempt = 1; attempt <= 5 && !connected; attempt++) {
    try {
      await c.connect();
      connected = true;
      console.log(`[${name}] connected on attempt ${attempt}`);
    } catch (e) {
      console.log(`[${name}] attempt ${attempt}: ${e.code || ''} ${e.message}`);
      c.removeAllListeners();
      try { c.end(); } catch {}
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  if (!connected) { console.log(`[${name}] giving up`); process.exit(1); }
  try {
    await c.query(sqlText);
    console.log(`[${name}] migration applied (batch)`);
  } catch (e) {
    console.log(`[${name}] batch failed (${(e.code||'').toString()}); per-statement fallback`);
    const stmts = sqlText.split(/;\s*\n/).map(s => s.trim()).filter(s => s && !/^BEGIN$/i.test(s) && !/^COMMIT$/i.test(s));
    for (const s of stmts) {
      try { await c.query(s + ';'); }
      catch (e2) {
        if (e2.code !== '42P07' && !/already exists/i.test(e2.message || '')) {
          console.log(`  stmt error: ${e2.message.slice(0,100)}`);
        }
      }
    }
    console.log(`[${name}] per-statement done`);
  }
  await c.end();
  process.exit(0);
})();
