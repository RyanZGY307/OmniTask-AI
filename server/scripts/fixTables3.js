const { Client } = require('pg');
const fs = require('fs');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_USER, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 45000 });
  await c.connect();
  const sql = fs.readFileSync('prisma/migrations-user.sql', 'utf8');
  for (const t of ['RefreshTask', 'ModelLimit']) {
    const m = sql.match(new RegExp('CREATE TABLE "' + t + '" \\([\\s\\S]*?\\);'));
    if (!m) { console.log(t + ': not in migration'); continue; }
    await c.query('DROP TABLE IF EXISTS "' + t + '" CASCADE');
    await c.query(m[0]);
    const cols = await c.query('select column_name from information_schema.columns where table_name=$1 order by ordinal_position', [t]);
    console.log(t + ': recreated (' + cols.rows.length + ' cols)');
  }
  await c.end(); process.exit(0);
})();
