// ================================================================
// 系统观测中心 — 纯逻辑测试
// Run: npx tsx test/observability.test.ts
//
// 只测 pgStats.ts 的纯函数（该文件刻意不 import db），因此无需 PostgreSQL。
// 覆盖：脱敏、过期判定、口径换算、容量滥用防护、同实例去重、
//       业务分类、分批计划、分页校验、陈旧度、BigInt/JSON 安全换算。
// ================================================================

import {
  redact, computeExpiresAt, isExpired, remainingSeconds, splitRelationSizes,
  utilizationPercent, aggregateInstances, classifyTable, planPurgeBatches,
  purgeLatencyMs, parseIsoOrNull, clampInt, staleness, toJsonNumber, jsonSafe,
  RETENTION_HOURS,
} from '../src/services/observability/pgStats';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') =>
  cond ? (pass++, console.log('  PASS', name)) : (fail++, console.log('  FAIL', name, detail));
const S = (name: string) => console.log('\n=== ' + name + ' ===');

const NOW = new Date('2026-10-23T08:00:00.000Z');

S('1. 脱敏规则（4 类）');
{
  const c = redact('连接 postgresql://admin:SuperSecret@db.host:5432/cortex_user');
  check('连接串被替换', !c.text.includes('SuperSecret'), c.text);
  check('记录 connection_string 规则', c.applied.includes('connection_string'));
  check('不含明文口令', !/SuperSecret/.test(c.text));

  const k = redact('api_key=sk-abcdef123456 正常文本');
  check('密钥键值对被替换', !k.text.includes('sk-abcdef123456'), k.text);
  check('记录 secret_kv 规则', k.applied.includes('secret_kv'));

  const j = redact('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N');
  check('JWT 被替换', !j.text.includes('eyJhbGciOiJIUzI1NiJ9'), j.text.slice(0, 60));
  check('记录 jwt 规则', j.applied.includes('jwt'));

  const neg = redact('普通任务描述：分析 cortex_user 的 User 表增长');
  check('无害文本不触发规则', neg.applied.length === 0 && neg.text.includes('cortex_user'));
  check('脱敏不误伤域名类文本', !neg.text.includes('REDACTED'));

  const empty = redact(null);
  check('null 安全', empty.text === '' && empty.applied.length === 0);
  const undef = redact(undefined);
  check('undefined 安全', undef.text === '');

  const obj = redact({ url: 'postgresql://u:p@host/db' });
  check('对象序列化后仍脱敏', !obj.text.includes('@host'), obj.text);
}

S('2. 24h 过期判定');
{
  check('保留期为 24 小时', RETENTION_HOURS === 24);

  const created = new Date('2026-10-22T08:00:00.000Z');
  const exp = computeExpiresAt(created);
  const deltaH = (exp.getTime() - created.getTime()) / 3600000;
  check('expiresAt = createdAt + 24h', Math.abs(deltaH - 24) < 1e-6, `${deltaH}`);

  check('正好 24h 视为已过期', isExpired(exp, exp) === true);
  check('23h59m 未过期', isExpired(exp, new Date(exp.getTime() - 60000)) === false);
  // 原断言写错：拿 exp+1s 当"现在"，那一刻它其实已过期。
  // 正确对照是 createdAt+23h（仍在 24h 窗口内）。
  check('窗口内未过期', isExpired(exp, new Date(created.getTime() + 23 * 3600000)) === false);
  check('超过 24h 已过期', isExpired(exp, new Date(created.getTime() + 25 * 3600000)) === true);
  check('坏时间视为过期（安全默认）', isExpired('not-a-date', NOW) === true);

  check('剩余秒数向上取整为 0', remainingSeconds(exp, exp) === 0);
  check('剩余秒数 1h 前 = 3600', remainingSeconds(exp, new Date(exp.getTime() - 3600000)) === 3600);
  check('过期时不返回负值', remainingSeconds(exp, new Date(exp.getTime() + 5000)) === 0);
}

S('3. 表/索引/TOAST 口径换算与去重');
{
  const total = 1000, table = 600, index = 300;
  const r = splitRelationSizes(total, table, index);
  check('三分相加 = total（无重叠）', r.tableBytes + r.indexBytes + r.toastBytes === total,
    `${r.tableBytes}+${r.indexBytes}+${r.toastBytes}`);
  check('toast = 差额 100', r.toastBytes === 100);

  const neg = splitRelationSizes(100, 80, 50); // 统计延迟可能微负
  check('负差额夹到 0', neg.toastBytes === 0);

  const big = splitRelationSizes(10 ** 15, 6 * 10 ** 14, 3 * 10 ** 14);
  check('万亿字节级三分正确', big.tableBytes + big.indexBytes + big.toastBytes === 10 ** 15);
}

S('4. 容量滥用防护（缺容量绝不算使用率）');
{
  check('容量缺失 → null', utilizationPercent(1024, null) === null);
  check('容量 undefined → null', utilizationPercent(1024, undefined) === null);
  check('容量 0 → null（除零防护）', utilizationPercent(1024, 0) === null);
  check('已用缺失 → null', utilizationPercent(null, 10000) === null);
  check('正常计算 50%', utilizationPercent(5000, 10000) === 50);
  check('百分比保留两位小数', utilizationPercent(1, 3) === 33.33);
}

S('5. 同实例去重（实例容量不重复计入）');
{
  const a = aggregateInstances([
    { instanceId: 'inst-1', sizeBytes: 1000, instanceDiskUsedBytes: 5000, instanceDiskTotalBytes: 10000, instanceDiskAvailableBytes: 5000 },
    { instanceId: 'inst-1', sizeBytes: 2000, instanceDiskUsedBytes: 5200, instanceDiskTotalBytes: 10000, instanceDiskAvailableBytes: 4800 },
  ]);
  check('逻辑占用可相加 = 3000', a.totalLogicalBytes === 3000, String(a.totalLogicalBytes));
  check('同实例只产出一行', a.instances.length === 1);
  check('实例已用取最大 = 5200', a.instances[0].usedBytes === 5200, String(a.instances[0].usedBytes));
  check('实例容量不叠加 = 10000', a.instances[0].totalBytes === 10000);
  check('使用率按去重后计算 52%', utilizationPercent(a.instances[0].usedBytes, a.instances[0].totalBytes) === 52);

  const b = aggregateInstances([
    { instanceId: 'inst-1', sizeBytes: 1000 },
    { instanceId: 'inst-2', sizeBytes: 500 },
    { instanceId: null, sizeBytes: 100 },
  ]);
  check('多实例分别统计', b.instances.length === 3, String(b.instances.length));
  check('未知实例也单列', b.instances.some((x) => x.instanceId === '__unknown__'));
  check('空输入不炸', aggregateInstances([]).instances.length === 0);
}

S('6. 业务分类（无证据必须 unclassified）');
{
  const u = classifyTable('public', 'User');
  check('User → 用户数据', u.category === '用户数据', u.category);
  check('高置信度带证据', u.confidence === 'high' && u.evidence.length > 0);

  const r = classifyTable('public', 'RequestTrace');
  check('链路表 → 对话数据', r.category === '对话数据', r.category);

  const un = classifyTable('public', 'ZzzWeirdTable');
  check('未知表 → unclassified', un.category === 'unclassified', un.category);
  check('未知表置信度 unknown', un.confidence === 'unknown');
  check('未知表说明为待识别', un.evidence.includes('待识别'));

  const empty = classifyTable('public', '');
  check('空表名不炸', empty.category === 'unclassified');
  const q = classifyTable('public', 'user_preference');
  check('小写表名不命中（大小写敏感，宁可漏不错归）', q.category === 'unclassified', q.category);
}

S('7. 分批删除计划');
{
  check('0 行 → 0 批', planPurgeBatches(0, 500) === 0);
  check('500 行 → 1 批', planPurgeBatches(500, 500) === 1);
  check('501 行 → 2 批', planPurgeBatches(501, 500) === 2);
  check('1000 行 → 2 批', planPurgeBatches(1000, 500) === 2);
  check('1500 行 → 3 批', planPurgeBatches(1500, 500) === 3);
  check('负数 → 0 批', planPurgeBatches(-5, 500) === 0);
  check('batch=0 兜底为 1', planPurgeBatches(100, 0) === 100);
}

S('8. 清理延迟与分页/参数校验');
{
  const del = new Date('2026-10-23T09:00:00.000Z');
  const exp = new Date('2026-10-23T08:59:30.000Z');
  check('延迟 30s = 30000ms', purgeLatencyMs(del, exp) === 30000);
  check('提前删除（异常）夹 0', purgeLatencyMs(new Date(exp.getTime() - 5000), exp) === 0);

  check('合法 ISO 解析', parseIsoOrNull('2026-10-23T08:00:00Z') instanceof Date);
  check('空串 → null', parseIsoOrNull('') === null);
  check('null → null', parseIsoOrNull(null) === null);
  check('非法字符串 → null', parseIsoOrNull('昨天') === null);

  check('clamp 默认值', clampInt('abc', 20, 1, 100) === 20);
  check('clamp 下限', clampInt('0', 20, 1, 100) === 1);
  check('clamp 上限', clampInt('999', 20, 1, 100) === 100);
  check('clamp 合法值', clampInt('50', 20, 1, 100) === 50);
  check('clamp undefined', clampInt(undefined, 20, 1, 100) === 20);
}

S('9. 陈旧度判定');
{
  check('从未采集 → stale', staleness(null, NOW).stale === true);
  check('从未采集 age null', staleness(null, NOW).ageSeconds === null);
  const fresh = new Date(NOW.getTime() - 60000);
  check('1 分钟内不 stale', staleness(fresh, NOW).stale === false);
  check('age = 60s', staleness(fresh, NOW).ageSeconds === 60);
  const old = new Date(NOW.getTime() - 20 * 60000);
  check('超过 15min → stale', staleness(old, NOW).stale === true);
  check('坏时间 → stale', staleness('xxx', NOW).stale === true);
}

S('10. BigInt / JSON 安全换算');
{
  check('小 BigInt → Number', toJsonNumber(1024n) === 1024);
  check('null → null', toJsonNumber(null) === null);
  check('字符串数字 → Number', toJsonNumber('2048') === 2048);
  check('非数字字符串 → null', toJsonNumber('abc') === null);
  check('NaN → null', toJsonNumber(NaN) === null);
  check('超大 BigInt → 字符串', typeof toJsonNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n) === 'string');

  const nested = jsonSafe({ a: 1n, b: [2n, null], c: { d: 3n } });
  const ok = (() => { try { JSON.stringify(nested); return true; } catch { return false; } })();
  check('嵌套 BigInt 可 JSON.stringify', ok, JSON.stringify(nested).slice(0, 80));
  check('嵌套值正确', jsonSafe({ x: 5n }).x === 5);
  check('数组保留长度', jsonSafe([1n, 2n]).length === 2);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
