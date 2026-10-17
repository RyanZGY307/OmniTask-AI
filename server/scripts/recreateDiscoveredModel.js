const { Client } = require('pg');
const fs = require('fs');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_USER, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 45000 });
  await c.connect();
  const sql = fs.readFileSync('prisma/migrations-user.sql', 'utf8');
  const m = sql.match(/CREATE TABLE "DiscoveredModel" \([\s\S]*?\);/);
  if (!m) { console.log('DiscoveredModel not in migration'); process.exit(1); }
  await c.query('DROP TABLE IF EXISTS "DiscoveredModel" CASCADE');
  await c.query(m[0]);
  const cols = await c.query('select column_name from information_schema.columns where table_name=$1 order by ordinal_position', ['DiscoveredModel']);
  console.log('DiscoveredModel: recreated (' + cols.rows.length + ' cols): ' + cols.rows.map(x => x.column_name).join(', '));
  await c.end(); process.exit(0);
})();
