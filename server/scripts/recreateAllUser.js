const { Client } = require('pg');
const fs = require('fs');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_USER, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 45000 });
  await c.connect();
  const sql = fs.readFileSync('prisma/migrations-user.sql', 'utf8');
  // Drop every table the new migration creates, then recreate them all.
  const tables = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map(m => m[1]);
  for (const t of tables) {
    await c.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
  }
  console.log('dropped ' + tables.length + ' tables');
  const stmts = sql.split(/;\n/).map(s => s.trim()).filter(s => s && !/^BEGIN$/i.test(s) && !/^COMMIT$/i.test(s));
  for (const s of stmts) {
    try { await c.query(s + ';'); }
    catch (e) { if (e.code !== '42P07' && !/already exists/i.test(e.message || '')) console.log('skip:', e.message.slice(0, 100)); }
  }
  const r = await c.query("SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  console.log('user DB now has ' + r.rows[0].n + ' tables');
  await c.end(); process.exit(0);
})();
