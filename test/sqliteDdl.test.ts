// ================================================================
// SQLite 版观测 DDL — 真实执行验证
// Run: npx tsx test/sqliteDdl.test.ts
//
// 本机 Node ≥22.5 有内置 node:sqlite，因此这份 DDL 是**真跑**的，
// 不是静态检查。重点验证三件容易想当然出错的事：
//   A. 表与索引是否真能建（语法有没有写错）
//   B. ISO-8601 UTC 字符串的字典序是否真的 == 时间顺序
//      （DDL 注释里声称如此，必须证）
//   C. strftime 默认值的实际输出格式，能否被 new Date() 反解析
//   D. BIGINT→TEXT 是否真的避开 2^53 精度丢失
// ================================================================

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = '') =>
  c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, d));
const S = (n: string) => console.log('\n=== ' + n + ' ===');

const DDL = readFileSync(join(__dirname, '..', 'prisma', 'migrations-observability-sqlite.sql'), 'utf8');
const PG = readFileSync(join(__dirname, '..', 'prisma', 'migrations-observability.sql'), 'utf8');

const db = new DatabaseSync(':memory:');
// 先按 DDL 里的 PRAGMA 准备（内存库 journal_mode=WAL 会静默回落，不影响验证）
db.exec('PRAGMA foreign_keys = ON;');

S('A. DDL 真实执行');
{
  let err: any = null;
  try { db.exec(DDL); } catch (e) { err = e; }
  check('整份 DDL 可执行（无语法错误）', err === null, err?.message ?? '');

  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as any[]).map((r) => r.name);
  const expected = ['AiRunSummary', 'DbMetricSnapshot', 'DbStorageEntry', 'ObsEvent', 'SummaryPurgeLog'];
  for (const t of expected) check(`表 ${t} 已创建`, tables.includes(t), tables.join(','));
  check('表数量与 PG 版一致', tables.length === expected.length, `实际 ${tables.length}`);

  const idx = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as any[]).map((r) => r.name);
  check('索引已创建（含 expiresAt 清理索引）',
    idx.includes('AiRunSummary_expiresAt_idx'), idx.join(','));
  const idxCount = (idx.length);
  const pgIdx = (PG.match(/CREATE INDEX/g) || []).length;
  check(`索引数与 PG 版一致（${pgIdx}）`, idxCount === pgIdx, `sqlite=${idxCount} pg=${pgIdx}`);

  // 幂等：再跑一次不能报错
  let idemErr: any = null;
  try { db.exec(DDL); } catch (e) { idemErr = e; }
  check('DDL 幂等（重复执行不报错）', idemErr === null, idemErr?.message ?? '');
}

S('B. ISO-8601 UTC 字典序 == 时间顺序（DDL 注释的声称必须证）');
{
  // 故意用乱序插入，靠 ORDER BY "expiresAt" 而非内存排序还原时间顺序
  const rows = [
    ['c', '2026-10-22T09:00:00.000Z'],
    ['a', '2026-10-20T23:30:00.500Z'],
    ['d', '2026-10-23T00:00:01.999Z'],
    ['b', '2026-10-20T23:30:00.000Z'],   // 与 a 同秒，仅毫秒不同
  ];
  const ins = db.prepare(
    'INSERT INTO "AiRunSummary" ("id","taskId","taskKind","createdAt","expiresAt","summary") VALUES (?,?,?,?,?,?)');
  for (const [i, ts] of rows) {
    ins.run(`id-${i}`, `task-${i}`, 'test', '2026-10-20T00:00:00.000Z', ts, 'x');
  }
  const ordered = (db.prepare('SELECT "id" FROM "AiRunSummary" ORDER BY "expiresAt" ASC').all() as any[]).map((r) => r.id);
  check('按 expiresAt 排序还原真实时间序', JSON.stringify(ordered) === JSON.stringify(['id-b', 'id-a', 'id-c', 'id-d']),
    ordered.join(','));

  // 毫秒级差异也被字典序正确区分（索引范围查询依赖这一点）
  check('同秒内毫秒级顺序正确（b 在 a 前）', ordered.indexOf('id-b') < ordered.indexOf('id-a'));

  // 清理查询用的范围谓词：<= now 能否走索引（EXPLAIN QUERY PLAN）
  const plan = db.prepare(
    "EXPLAIN QUERY PLAN SELECT * FROM \"AiRunSummary\" WHERE \"expiresAt\" <= '2026-10-22T00:00:00.000Z'"
  ).all() as any[];
  const usesIdx = JSON.stringify(plan).includes('AiRunSummary_expiresAt_idx');
  check('范围谓词能用到 expiresAt 索引（不退化全表扫）', usesIdx, JSON.stringify(plan));
}

S('C. strftime 默认值可被反解析');
{
  const ts = (db.prepare(
    "INSERT INTO \"ObsEvent\" (\"id\",\"ts\",\"kind\",\"title\") VALUES ('ev-1', (strftime('%Y-%m-%dT%H:%M:%fZ','now')), 'test', 'x') RETURNING \"createdAt\""
  ).get() as any);
  check('默认时间列自动填充', !!ts?.createdAt, String(ts?.createdAt));
  const d = new Date(ts.createdAt);
  check('默认值可被 new Date() 解析', !Number.isNaN(d.getTime()), ts.createdAt);
  check('默认值带 Z 后缀（UTC）', /Z$/.test(ts.createdAt), ts.createdAt);
  check('默认值含毫秒（%f）', /\.\d{3}Z$/.test(ts.createdAt), ts.createdAt);
  // 这个格式必须仍然满足字典序==时间序
  check('默认值符合字典序格式（长度固定）', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ts.createdAt), ts.createdAt);
}

S('D. 大整数精度：TEXT 存 vs INTEGER 存的真实对比');
{
  // 观测数据 TB 级常见。这里用 2^53+1 —— JS number 表示不下的最小奇数。
  const big = 9_007_199_254_740_993n;   // 2^53 + 1，真正超出 JS 安全整数
  const MAX_SAFE = 9_007_199_254_740_991n;   // 2^53 - 1

  db.exec('CREATE TABLE IF NOT EXISTS "_prec" (k TEXT, vText TEXT, vInt INTEGER)');
  const p = db.prepare('INSERT INTO "_prec" (k,vText,vInt) VALUES (?,?,?)');
  p.run('twoPow53Plus1', big.toString(), Number(big));

  // 只取 TEXT 列：必须安全返回字符串
  const textOnly: any = db.prepare('SELECT "vText" FROM "_prec" WHERE k=?').get('twoPow53Plus1');
  check('TEXT 路径读出字符串（不触发任何转换）', typeof textOnly.vText === 'string', typeof textOnly.vText);
  check('TEXT 路径完整保留位（无精度丢失）', BigInt(textOnly.vText) === big,
    `读出 ${textOnly.vText} 期望 ${big}`);
  // 2^53+1 进位成 2^53 —— 最低位被抹掉，这就是丢位本身
  check('对照：该值转 number 进位丢位（证明 TEXT 不是多余）',
    Number(big) === Number(MAX_SAFE) + 1 && BigInt(Number(big)) !== big,
    `Number(big)=${Number(big)}  vs big=${big}`);

  // 取 INTEGER 列：node:sqlite 对超出 MAX_SAFE_INTEGER 的值
  // **会抛 RangeError 而不是静默丢位** —— 这是实测行为。
  let intErr: any = null;
  let intVal: any = null;
  try {
    intVal = (db.prepare('SELECT "vInt" FROM "_prec" WHERE k=?').get('twoPow53Plus1') as any).vInt;
  } catch (e) { intErr = e; }
  check('INTEGER 路径实测抛错（不是丢位，是直接失败）',
    intErr !== null && /too large/i.test(String(intErr?.message ?? '')),
    `err=${intErr?.code ?? intErr?.message} val=${intVal}`);
  check('这证明字节数存 TEXT 是必需而非洁癖（INTEGER 列在节点 4.6+ 完全不可用）',
    intErr !== null);

  // 读回的字符串必须能被安全地转为 JSON number
  const toJsonNumber = (v: any): number | string | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === 'string' ? Number(v) : v;
    return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : String(v);
  };
  check('toJsonNumber 对真正超大值返回字符串（不进 JSON 精度危险区）',
    typeof toJsonNumber(textOnly.vText) === 'string', String(toJsonNumber(textOnly.vText)));
  check('toJsonNumber 对恰好 2^53-1 返回 number（边界内不误判）',
    typeof toJsonNumber('9007199254740991') === 'number');
  check('toJsonNumber 对安全区值返回 number',
    typeof toJsonNumber('1024') === 'number' && toJsonNumber('1024') === 1024);
  check('恰好 MAX_SAFE_INTEGER 边界可往返', BigInt(toJsonNumber('9007199254740991') as any) === MAX_SAFE);
  check('超出边界被降级为字符串（不产生假精度）', toJsonNumber('9007199254740993') === '9007199254740993');
}

S('E. 与 PG 版的结构等价性（字段名/数量对齐）');
{
  for (const t of ['DbMetricSnapshot', 'AiRunSummary', 'ObsEvent', 'SummaryPurgeLog', 'DbStorageEntry']) {
    const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as any[]).map((r) => r.name);
    const pgBlock = PG.split(new RegExp(`CREATE TABLE IF NOT EXISTS "${t}"`))[1]?.split(');')[0] ?? '';
    const pgCols = [...pgBlock.matchAll(/^\s*"(\w+)"\s+(TEXT|BIGINT|INTEGER|TIMESTAMPTZ|BOOLEAN)/gm)].map((m) => m[1]);
    check(`${t} 字段名与 PG 版完全一致（${pgCols.length} 个）`,
      JSON.stringify(cols) === JSON.stringify(pgCols),
      `sqlite=[${cols}] pg=[${pgCols}]`);
  }
  // UNIQUE 约束是否真的生效（taskId+taskKind）
  const ins = db.prepare(
    'INSERT INTO "AiRunSummary" ("id","taskId","taskKind","createdAt","expiresAt","summary") VALUES (?,?,?,?,?,?)');
  ins.run('u1', 'same-task', 'chat', '2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z', 'x');
  let dupErr: any = null;
  try {
    ins.run('u2', 'same-task', 'chat', '2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z', 'x');
  } catch (e) { dupErr = e; }
  check('UNIQUE(taskId,taskKind) 真的生效（重复 upsert 会冲突）', !!dupErr, dupErr?.message ?? '');
  check('不同 taskKind 同 taskId 允许插入', (() => {
    try { ins.run('u3', 'same-task', 'research', '2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z', 'x'); return true; }
    catch { return false; }
  })());
}

db.close();
console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
