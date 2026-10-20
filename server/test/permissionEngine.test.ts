// P1：连接器安全地基测试（纯逻辑部分）。
//
// 被测对象：
//   - connections/contract.ts（isRetryable 与权限/未知结果的关系）
//   - connections/vault.ts（AES-256-GCM 加解密往返、密钥来源、篡改检测）
//   - connections/permissionEngine.ts（R0–R4 策略、R4 上限、normalizePolicy）
//
// 权限引擎与凭据库是审计中确认「真实实现且质量不低」的两块地基；任务书 P1
// 要求"保留并扩展，不因接入 MCP 而降低既有权限要求"。本文件把现有行为的
// 边界固定成测试，后续扩展若削弱这些边界会立刻失败。
//
// 关于本机限制（如实声明，不用假内存库冒充）：
//   checkPermission 的第一步是 getPolicy() → prisma.userSetting.findUnique()。
//   本机 node_modules 里装的是 x86_64 的 Prisma 查询引擎
//   （libquery_engine-debian-openssl-1.1.x.so.node），而运行架构是 Android
//   arm64，dlopen 直接失败："is for EM_X86_64 (62) instead of EM_AARCH64 (183)"。
//   这属于环境限制，不是被测代码缺陷。因此与 DB 相关的断言显式记为 SKIP，
//   绝不用异常兜底伪装成 PASS。
//
//   db.ts 在模块顶层 resolve 4 个 DATABASE_URL_* 并 throw（4 库架构要求启动
//   即配齐，是设计而非缺陷）。故这里先设占位 URL 让模块可加载。

process.env.DATABASE_URL_USER ||= 'postgresql://u:p@127.0.0.1:5432/cortex_user?connection_limit=1';
process.env.DATABASE_URL_CONVERSATION ||= 'postgresql://u:p@127.0.0.1:5432/cortex_conversation?connection_limit=1';
process.env.DATABASE_URL_KNOWLEDGE ||= 'postgresql://u:p@127.0.0.1:5432/cortex_knowledge?connection_limit=1';
process.env.DATABASE_URL_OVERFLOW ||= 'postgresql://u:p@127.0.0.1:5432/cortex_overflow?connection_limit=1';

// TS 的 import 提升会把 import 排到上面的 env 赋值之前执行，导致 db.ts 在
// 占位 URL 写入前就 throw。因此这里一律用 require（按语句顺序求值）。
const crypto = require('crypto');
const { R, isRetryable } = require('../src/connections/contract');
const { initVault, encryptSecret, decryptSecret, vaultKeySource } = require('../src/connections/vault');
const { DEFAULT_POLICY, normalizePolicy, checkPermission } = require('../src/connections/permissionEngine');

let pass = 0;
let fail = 0;
const unverified: string[] = [];

function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

const SECTION = (n: string) => console.log('\n' + n);

(async () => {
  SECTION('1. 默认策略 — R0/R1 自主，R2/R3 需确认，R4 拒绝');
  check('R0 默认 auto', DEFAULT_POLICY.R0 === 'auto');
  check('R1 默认 auto', DEFAULT_POLICY.R1 === 'auto');
  check('R2 默认 confirm', DEFAULT_POLICY.R2 === 'confirm');
  check('R3 默认 confirm', DEFAULT_POLICY.R3 === 'confirm');
  check('R4 默认 never', DEFAULT_POLICY.R4 === 'never');

  SECTION('2. normalizePolicy — R4 永不可能被放宽成 auto');
  check('显式 R4:auto 被强制为 confirm', normalizePolicy({ R4: 'auto' }).R4 === 'confirm');
  check('合法值被接受（R0:confirm）', normalizePolicy({ R0: 'confirm' }).R0 === 'confirm');
  check('合法值被接受（R1:never）', normalizePolicy({ R1: 'never' }).R1 === 'never');
  check('null 回落默认值', normalizePolicy(null).R2 === 'confirm');
  check('未知值被忽略并回落默认', normalizePolicy({ R2: 'bogus' }).R2 === 'confirm');

  SECTION('3. 契约层 — 权限拒绝与结果未知不可重试');
  check('denied 结果不可重试', isRetryable(R.denied('policy')) === false);
  check('unknown（结果未知）不可无条件重试', isRetryable(R.unknown('timeout')) === false);
  check('timeout 不可无条件重试（外部可能已执行）', isRetryable(R.timeout('x', 30)) === false);
  check('not_implemented 不可重试', isRetryable(R.notImplemented('x')) === false);
  check('unavailable 不可重试', isRetryable(R.unavailable('x')) === false);
  check('success 不可重试', isRetryable(R.success()) === false);

  SECTION('4. Vault — AES-256-GCM 往返');
  process.env.VAULT_KEY = crypto.randomBytes(32).toString('base64');
  initVault(true);
  check('密钥来源为 VAULT_KEY env', vaultKeySource() === 'VAULT_KEY env');

  const secret = 'ghp_supersecrettokenvalue_1234567890';
  const blob = encryptSecret(secret);
  const parsed = JSON.parse(blob);
  check('密文是含 c/iv/tag 的 JSON', !!parsed.c && !!parsed.iv && !!parsed.tag);
  check('密文中不含明文 token', !blob.includes('supersecrettoken'));
  check('iv 每次不同（语义安全）', encryptSecret(secret) !== blob);

  const back = decryptSecret(blob);
  check('往返解密还原明文', back === secret);

  let tamperRejected = false;
  try {
    decryptSecret(JSON.stringify({ ...parsed, c: parsed.c.slice(0, -4) + 'AAAA' }));
  } catch { tamperRejected = true; }
  check('改动密文被 GCM auth tag 拒绝', tamperRejected);

  check('空串可加密并还原', decryptSecret(encryptSecret('')) === '');
  const long = 'x'.repeat(100000);
  check('100KB 凭据可加密并还原', decryptSecret(encryptSecret(long)) === long);

  SECTION('5. checkPermission — 连接态门与能力门（需真实 DB）');
  let dbUnavailable = false;
  try {
    await checkPermission({ userId: 'u', riskLevel: 'R0', connection: null });
  } catch (e: any) {
    dbUnavailable = /EM_X86_64|PrismaClientInitializationError|DATABASE_URL/i.test(String(e?.message || e));
  }
  if (dbUnavailable) {
    console.log('  SKIP  checkPermission 的 DB 相关断言 — 本机 Prisma 引擎架构不匹配');
    console.log('        （arm64 无法加载 x86_64 查询引擎）。需在 x86_64 + 真实 DB 环境执行：');
    console.log('          - 连接非 active 时，即使风险为 R0 也必须拒绝');
    console.log('          - 连接缺少 requiredCapability 时必须拒绝');
    console.log('          - R2/R3 默认策略产生 confirm（进入审批而非执行）');
    console.log('          - R4 恒定 confirm/never，永不被放宽为 auto');
    unverified.push('checkPermission：连接态门、能力门、R2/R3 confirm 分流（依赖 prisma.userSetting）');
    unverified.push('storeCredential/getSecret/revokeCredential 的持久化路径（含过期拒绝、userId 归属校验）');
  } else {
    const revoked = await checkPermission({
      userId: 'u', riskLevel: 'R0', requiredCapability: 'github.repo.read',
      connection: { status: 'revoked', permissions: ['github.repo.read'] },
    });
    check('revoked 连接拒绝 R0 只读调用', revoked.decision === 'deny', JSON.stringify(revoked));
    check('  拒绝原因指向连接状态', /revoked/i.test(revoked.reason || ''));

    const noCap = await checkPermission({
      userId: 'u', riskLevel: 'R0', requiredCapability: 'github.repo.write',
      connection: { status: 'active', permissions: ['github.repo.read'] },
    });
    check('连接缺少该能力 → deny', noCap.decision === 'deny');
    check('  原因指出缺失的能力', /github\.repo\.write/.test(noCap.reason || ''));
  }

  console.log(`\nP1 安全测试：${pass} 通过 / ${fail} 失败`);
  if (unverified.length) {
    console.log(`\nⓘ 未验证 ${unverified.length} 项（本机环境限制，非代码缺陷）：`);
    for (const u of unverified) console.log('   -', u);
  }
  process.exitCode = fail > 0 ? 1 : 0;
})().catch((e) => { console.error('P1 测试崩溃:', e); process.exit(1); });
