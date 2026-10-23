// ================================================================
// DB 连接适配层 — 连接规格解析测试
// Run: npx tsx test/dbAdapterSpec.test.ts
// 纯解析逻辑，无需任何驱动或数据库。
// ================================================================

import {
  parseConnection, redactSpec, requiresApiKey, describeSpec, engineForFrequency,
  placementFor, DOMAIN_PLACEMENT,
} from '../src/services/dbAdapter/spec';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = '') =>
  c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, d));
const S = (n: string) => console.log('\n=== ' + n + ' ===');

S('1. PostgreSQL 连接串');
{
  const s = parseConnection('postgres://u:p@db.host.com:5432/cortex_user?sslmode=require');
  check('识别为 postgres', s.engine === 'postgres', s.engine);
  check('authMode=inline', s.authMode === 'inline');
  check('库名提取', s.pg?.database === 'cortex_user', s.pg?.database);
  check('端口提取', s.pg?.port === 5432, String(s.pg?.port));
  check('ssl 识别', s.pg?.ssl === true);
  check('host 脱敏提取', s.host === 'db.host.com', s.host ?? 'null');
  check('redactSpec 不含口令', !JSON.stringify(redactSpec(s)).includes('secret'), JSON.stringify(redactSpec(s)));
  check('redactSpec 不含裸口令段', !JSON.stringify(redactSpec(s)).includes(':p@'));
  check('输出不含 raw 字段', !('raw' in s));
  check('无错误', s.error === null);

  const noSsl = parseConnection('postgresql://host/db');
  check('缺省 ssl=false', noSsl.pg?.ssl === false);
  check('端口可空', noSsl.pg?.port === null);

  const bad = parseConnection('postgres://host/');
  check('缺库名 → error', !!bad.error, bad.error ?? '');

  check('superuser 前缀形式', parseConnection('postgresql://a:b@h:5433/db2').engine === 'postgres');
}

S('2. SQLite（三种写法）');
{
  const f = parseConnection('file:/var/data/cortex.sqlite');
  check('file: → sqlite', f.engine === 'sqlite', f.engine);
  check('authMode=none', f.authMode === 'none');
  check('路径提取', f.filePath === '/var/data/cortex.sqlite', f.filePath ?? 'null');
  check('归一化带 file: 前缀', f.normalized === 'file:/var/data/cortex.sqlite');
  check('host 为 null', f.host === null);

  const p = parseConnection('sqlite:/var/data/x.db?mode=ro');
  check('sqlite: → sqlite', p.engine === 'sqlite');
  check('query 被剥离', p.filePath === '/var/data/x.db', p.filePath ?? 'null');

  const rel = parseConnection('./data/local.db');
  check('相对路径 → sqlite', rel.engine === 'sqlite', rel.engine);
  check('相对路径保留', rel.filePath === './data/local.db');

  const mem = parseConnection(':memory:');
  check(':memory: 识别', mem.filePath === ':memory:');

  const bad = parseConnection('file:');
  check('空路径 → error', !!bad.error);
}

S('3. libSQL / Turso（authToken 即 API key）');
{
  const s = parseConnection('libsql://my-db.turso.io/cortex?authToken=eyJabc.def.ghi');
  check('识别 libsql', s.engine === 'libsql', s.engine);
  check('authMode=api-key', s.authMode === 'api-key');
  check('apiKey 提取', s.apiKey === 'eyJabc.def.ghi');
  check('host 提取', s.host === 'my-db.turso.io', s.host ?? 'null');
  check('target 提取', s.target === 'cortex', s.target);
  check('描述不含 token', !describeSpec(s).includes('eyJabc'));

  const emptyToken = parseConnection('libsql://h/db?authToken=');
  check('空 authToken → error', !!emptyToken.error);
}

S('4. 独立 API key（三种形式）');
{
  const bare = parseConnection('api-key:sk_live_abcdef123456&endpoint=libsql://h.turso.io/db');
  check('api-key: 前缀 → api-key 模式', bare.authMode === 'api-key', bare.authMode);
  check('key 提取', bare.apiKey === 'sk_live_abcdef123456');
  check('endpoint 推引擎', bare.engine === 'libsql', bare.engine);
  check('无错误', bare.error === null, bare.error ?? '');

  const bareNoEp = parseConnection('api-key:sk_live_xxxx');
  check('裸 key 缺 endpoint → error', !!bareNoEp.error && bareNoEp.error.includes('endpoint'), bareNoEp.error ?? '');

  const kv = parseConnection('apikey=sk_test_999');
  check('apikey= 形式', kv.authMode === 'api-key');
  check('key 正确', kv.apiKey === 'sk_test_999');

  const empty = parseConnection('api-key:');
  check('空 key → error', !!empty.error);
  check('空 key 仍识别为 api-key 形式', empty.authMode === 'api-key', empty.authMode);
  check('空 key 错误信息精确', (empty.error ?? '').includes('API key 为空'), empty.error ?? '');
  // requiresApiKey 语义：声明要 api-key 但**没给出** key 时为 true
  check('空 key → requiresApiKey=true', requiresApiKey(empty) === true);
  const bareNoEp2 = parseConnection('api-key:sk_live_xxxx');
  check('裸 key（有 key 无 endpoint）→ requiresApiKey=false', requiresApiKey(bareNoEp2) === false);
  check('裸 key 报缺 endpoint 而非缺 key', (bareNoEp2.error ?? '').includes('endpoint'));
  const noTok = parseConnection('libsql://h/db?authToken=');
  check('libsql 空 authToken → requiresApiKey=true', requiresApiKey(noTok) === true);
  check('PG 连接串不要求 api-key', requiresApiKey(parseConnection('postgres://u:p@h/db')) === false);
  check('SQLite 文件不要求 api-key', requiresApiKey(parseConnection('file:/x.db')) === false);

  const http = parseConnection('https://db.example.com/query?apiKey=tok_123');
  check('HTTP+apiKey → api-key', http.authMode === 'api-key');
  check('key 提取', http.apiKey === 'tok_123');

  const httpNoKey = parseConnection('https://db.example.com/query');
  check('HTTP 无 key → error', !!httpNoKey.error);
}

S('5. 无法识别 / 空输入');
{
  check('空字符串 → error', !!parseConnection('').error);
  check('null → error', !!parseConnection(null).error);
  check('undefined → error', !!parseConnection(undefined).error);
  check('数字 → error', !!parseConnection(12345 as any).error);
  const junk = parseConnection('???');
  check('垃圾输入 → error 且 engine=unknown', !!junk.error && junk.engine === 'unknown');
  check('解析绝不抛异常', (() => { try { parseConnection(':::::'); return true; } catch { return false; } })());
}

S('6. 脱敏描述');
{
  check('PG 描述不含口令', !describeSpec(parseConnection('postgres://u:secret@h/db')).includes('secret'));
  check('libSQL 描述标注 api-key', describeSpec(parseConnection('libsql://h/db?authToken=x')).includes('api-key'));
  check('SQLite 文件描述', describeSpec(parseConnection('file:/x/y.db')).includes('SQLite'));
  check('内存库描述', describeSpec(parseConnection(':memory:')).includes('内存'));
}

S('7. 频率分级 → 引擎选择');
{
  check('高频强制 postgres', engineForFrequency('high') === 'postgres');
  check('中频 → sqlite', engineForFrequency('medium') === 'sqlite');
  check('低频 → sqlite', engineForFrequency('low') === 'sqlite');
  check('绝不为低频选 postgres 之外的东西', engineForFrequency('low') !== 'unknown');

  const conv = placementFor('conversation');
  check('对话标记高频', conv?.frequency === 'high');
  check('对话留 PG 有理由', (conv?.reason ?? '').includes('PostgreSQL'));

  const obs = placementFor('observability');
  check('观测标记低频', obs?.frequency === 'low');
  check('观测适合 SQLite', (obs?.reason ?? '').includes('SQLite'));

  check('未知 domain → null', placementFor('nope') === null);

  // 关键不变量：任何含 user/conversation 的域不得被降级
  for (const d of DOMAIN_PLACEMENT) {
    if (d.domain === 'user' || d.domain === 'conversation') {
      check(`${d.domain} 不得降级到 SQLite`, engineForFrequency(d.frequency) === 'postgres');
    }
  }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
