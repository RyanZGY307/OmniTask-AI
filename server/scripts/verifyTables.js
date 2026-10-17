const { Client } = require('pg');
const TARGETS = [
  { name: 'user', url: process.env.DATABASE_URL_USER },
  { name: 'conversation', url: process.env.DATABASE_URL_CONVERSATION },
  { name: 'knowledge', url: process.env.DATABASE_URL_KNOWLEDGE },
  { name: 'overflow', url: process.env.DATABASE_URL_OVERFLOW },
];
(async () => {
  for (const t of TARGETS) {
    const c = new Client({ connectionString: t.url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 45000 });
    try {
      await c.connect();
      const r = await c.query(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`);
      console.log(`[${t.name}] ${r.rows[0].n} tables`);
    } catch (e) { console.log(`[${t.name}] ${e.message}`); }
    await c.end();
  }
  process.exit(0);
})();
