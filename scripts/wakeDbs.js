// Wake + verify all 4 layerbase Postgres DBs. Each can be sleeping; a
// first connect can stall 10-30s until the pooler wakes it. Retry up to 5x.
const { Client } = require('pg');

const DBS = {
  USER: process.env.DATABASE_URL_USER || '',
  CONVERSATION: process.env.DATABASE_URL_CONVERSATION || '',
  KNOWLEDGE: process.env.DATABASE_URL_KNOWLEDGE || '',
  OVERFLOW: process.env.DATABASE_URL_OVERFLOW || '',
};

function one(url, label, attempt) {
  return new Promise((resolve) => {
    const c = new Client({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 45000,
    });
    const t = setTimeout(() => { c.end(); resolve(false); }, 60000);
    c.connect().then(async () => {
      const { rows } = await c.query('select 1');
      c.end();
      clearTimeout(t);
      console.log(`[${label}] OK on attempt ${attempt}`);
      resolve(true);
    }).catch((e) => {
      clearTimeout(t);
      console.log(`[${label}] attempt ${attempt} failed: ${e.code || ''} ${e.message}`.slice(0, 160));
      resolve(false);
    });
  });
}

async function wake(label, url) {
  if (!url) { console.log(`[${label}] no URL set, skipping`); return; }
  for (let i = 1; i <= 5; i++) {
    if (await one(url, label, i)) return;
    await new Promise(r => setTimeout(r, 8000));
  }
  console.log(`[${label}] still unreachable after 5 attempts`);
}

(async () => {
  for (const [label, url] of Object.entries(DBS)) await wake(label, url);
  process.exit(0);
})();
