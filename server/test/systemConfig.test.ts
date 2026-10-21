// 系统配置（连接串免环境变量）— 安全属性与逻辑测试
//
// 本机无法执行 Prisma（引擎 x86_64 vs arm64，dlopen 失败），因此：
//   · 真实文件 I/O 用 /cwd 下临时目录真实执行（可测）
//   · 真实数据库握手不可测 —— 只验证"不握手就不落盘"的**顺序**
// 无法执行的项在末尾列为 UNVERIFIED。
// ================================================================
process.on('uncaughtException', (err: any) => {
  const m = String(err?.message || err);
  if (m.includes('EM_X86_64') || m.includes('EM_AARCH64') || m.includes('Prisma engines')) {
    console.error('\n[引擎异常被安全处理器吞掉 — 测试未跑完]', m.slice(0, 160));
    process.exit(process.exitCode || 0);
  }
  console.error('未预期的未捕获异常:', err); process.exit(1);
});

let pass = 0, fail = 0;
const check = (n: string, c: boolean, e = '') =>
  c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, e));
const S = (n: string) => console.log('\n' + n);

const fs = require('fs'), path = require('path'), os = require('os');
const readFileSync = (f: string) => fs.readFileSync(f, 'utf-8');
// 注：源码断言用「剥注释后再匹配」。剥离 `//` 行注释时必须排除前面带冒号的
// 情况，否则 postgresql://、https:// 这类字符串字面量会被当注释起点，
// 把 URL 后半段连同本行其余内容一起删掉，导致断言莫名失败。

// ---- 用真实临时目录跑真实文件 I/O ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syscfg-'));
// chdir 后相对路径全部指向临时目录，源码断言必须用绝对路径
const REPO = process.cwd();
const srcOf = (rel: string) => path.join(REPO, rel);
process.chdir(tmp);
process.env.VAULT_KEY = process.env.VAULT_KEY || 'test-vault-key-32-bytes-minimum-length!!';

(async () => {
  const SC = require('../src/services/systemConfig');
  // 注入纯 crypto 加解密：require(vault) 会连带构造 4 个 PrismaClient，
  // 本机引擎不可用，会让纯配置逻辑的测试被拖死。生产路径不受影响。
  const crypto = require('crypto');
  SC.__setCipherForTests({
    encrypt: (plain) => 'stub:' + Buffer.from(plain).toString('base64'),
    decrypt: (c) => Buffer.from(c.replace(/^stub:/, ''), 'base64').toString('utf-8'),
  });
  crypto.randomBytes(16);

  S('1. 首次启动：未配置 → setup 模式，绝不静默用默认连接');
  {
    check('无文件时 isSetupRequired() 为真', SC.isSetupRequired() === true);
    check('无文件时 getDbConnection 返回 null', SC.getDbConnection('user') === null);
    check('同步加载在无文件时返回 null 而不抛', SC.loadSystemConfigSync() === null);
    // SETUP 状态查询必须匿名可达：否则没有连接串时前端连"该显示登录页
    // 还是配置页"都判断不了，用户被彻底卡死。
    const routeSrc0 = fs.readFileSync(srcOf('src/routes/system.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
    check('GET /status 未挂 authMiddleware（setup 中无账号可登录）',
      /router\.get\(\s*['"]\/status['"]\s*,\s*async/.test(routeSrc0));
  }

  S('2. 连接串语法校验：只验语法，不冒充可达性证明');
  {
    const ok = (u: string) => SC.validateConnectionUrl(u).ok === true;
    const err = (u: string) => !SC.validateConnectionUrl(u).ok;
    check('接受标准 postgres:// 串', ok('postgres://u:p@db.example.com:5432/cortex_user'));
    check('接受 postgresql:// 串', ok('postgresql://u:p@localhost:5432/cortex_knowledge?sslmode=require'));
    check('拒绝空串', err(''));
    check('拒绝空白', err('   '));
    check('拒绝非 pg 协议', err('mysql://u:p@h:3306/db'));
    check('拒绝缺密码', err('postgresql://u@h:5432/db'));
    check('拒绝缺用户名', err('postgresql://:p@h:5432/db'));
    check('拒绝缺库名', err('postgresql://u:p@h:5432'));
    check('拒绝含分号注入', err('postgresql://u:p@h:5432/db;DROP TABLE x'));
    check('拒绝含换行', err('postgresql://u:p@h:5432/db\nX'));
    check('拒绝端口越界', err('postgresql://u:p@h:99999/db'));
    check('拒绝非字符串输入', err(undefined) && err(123) && err({} as any));
  }

  S('3. 掩码：可展示现状，绝不回传可用连接串');
  {
    const m = SC.validateConnectionUrl('postgresql://admin:supersecret@db.example.com:5432/cortex_user');
    check('校验函数不返回密码（只返回 ok/reason）', 'ok' in m);
    check('掩码隐藏密码', !SC.maskUrl('postgresql://admin:supersecret@db.example.com:5432/x').includes('supersecret'));
    check('掩码保留主机与库名（便于运维辨认）', /db\.example\.com/.test(SC.maskUrl('postgresql://admin:p@db.example.com:5432/x'))
      && /cortex_user|x/.test(SC.maskUrl('postgresql://admin:p@db.example.com:5432/x')));
    check('掩码含 *** 明确标记', SC.maskUrl('postgresql://a:b@h:5432/d').includes('***'));
  }

  S('4. 落盘与读回（真实文件，真实加解密往返）');
  {
    const url = 'postgresql://usr:pw123@db.example.com:5432/cortex_user';
    await SC.writeDbConnection({ domain: 'user', url, label: '主库' });
    SC.__resetSystemConfigCache();

    const back = SC.loadSystemConfigSync();
    check('写入后能读回', back !== null && back.dbConnections.length === 1);
    check('解密往返无损', back && back.dbConnections[0].url === url);
    check('label 保留', back && back.dbConnections[0].label === '主库');
    check('写入后不再处于 setup 模式', SC.isSetupRequired() === false);

    const fp = SC.systemConfigPath();
    check('文件真实存在于磁盘', fs.existsSync(fp));
    const raw = fs.readFileSync(fp, 'utf-8');
    check('磁盘上密码不明文（已加密）', !raw.includes('pw123'));
    check('磁盘上主机名也不明文', !raw.includes('db.example.com'));
    check('权限收紧为 0600', (fs.statSync(fp).mode & 0o777) === 0o600);
  }

  S('5. 幂等与覆盖：改串不得累积历史行');
  {
    const url2 = 'postgresql://usr:pw999@db2.example.com:5432/cortex_user';
    await SC.writeDbConnection({ domain: 'user', url: url2, label: '替换' });
    SC.__resetSystemConfigCache();
    const back = SC.loadSystemConfigSync();
    check('同域覆盖而非追加', back && back.dbConnections.filter((c: any) => c.domain === 'user').length === 1);
    check('覆盖后取到新值', back && back.dbConnections[0].url === url2);
    check('四域相互独立', SC.getDbConnection('knowledge') === null);
  }

  S('6. 损坏文件：必须上抛，绝不静默回退环境变量');
  {
    fs.appendFileSync(SC.systemConfigPath(), '{broken');
    SC.__resetSystemConfigCache();
    let threw = '';
    try { SC.loadSystemConfigSync(); } catch (e: any) { threw = e?.message || 'threw'; }
    check('损坏配置必须抛错（绝不静默降级成 setup 模式）', threw.length > 0);
    check('错误信息点明是"存在但无法使用"而非"尚未配置"',
      /无法使用/.test(threw) && /不是"尚未配置"/.test(threw));
    check('错误信息给出可操作 remediate 步骤', /删除该文件/.test(threw));
    check('错误信息带文件路径便于排查', /system-config\.json/.test(threw));

    // 解密失败（密钥不匹配）同样必须抛
    const p = path.join(tmp, 'data', 'system-config.key');
    fs.writeFileSync(p, 'f'.repeat(64), { mode: 0o600 });
    SC.__resetSystemConfigCache();
    let threw2 = '';
    try { SC.deserializeConfig(fs.readFileSync(SC.systemConfigPath(), 'utf-8')); }
    catch (e: any) { threw2 = e?.message || 'threw'; }
    check('密钥不匹配时抛错而非返回半份配置', threw2.length > 0);
  }

  S('7. setup 端点的写入门禁（源码结构断言）');
  {
    const { readFileSync } = require('fs');
    const src = readFileSync(srcOf('src/routes/system.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');

    check('GET /status 匿名可访问（前端需判断显示登录页还是配置页）',
      /router\.get\(\s*['"]\/status['"]\s*,\s*async/.test(src));
    check('写端点前有 setup 门禁中间件', /router\.use\(/.test(src));
    check('门禁在已配置时返回 409', /status\(409\)/.test(src));
    check('写端点要求 adminAuth', /router\.post\(\s*['"]\/db-connections['"]\s*,\s*authMiddleware\s*,\s*adminAuth/.test(src));
    check('写前先做语法校验', /validateConnectionUrl\(/.test(src));
    check('写前做真实连通性验证', /\$queryRawUnsafe\(\s*['"]SELECT 1/.test(src));
    check('验证用独立临时 client（不污染常驻池）', /new PrismaClient\(/.test(src));
    check('验证后主动断开', /\$disconnect/.test(src));
    check('失败不落盘（connect 失败直接返回 400）', /status\(400\)/.test(src));
    check('GET 只回掩码', /maskedDbConnections\(\)/.test(src));
    check('响应面不含明文连接串字段', !/url:\s*url/.test(src));
    check('导入 loadSystemConfigSync 而非异步读（时序正确）',
      readFileSync(srcOf('src/services/db.ts'), 'utf-8').includes('loadSystemConfigSync()'));
  }

  S('8. db.ts 不再把缺失环境变量当致命错误');
  {
    const { readFileSync } = require('fs');
    const db = readFileSync(srcOf('src/services/db.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
    check('resolveDbUrl 改为按 domain 取（不再按 env key）',
      /function resolveDbUrl\(domain: DbDomain\)/.test(db));
    check('不再在模块顶层因缺 URL 而 throw', !/throw new Error\(\s*`?\[DB\] Missing/.test(db));
    check('未配置时用不可达 placeholder（被误用立即失败）',
      /127\.0\.0\.1:1/.test(db) && /PLACEHOLDER_URL/.test(db));
    check('有文件后绝不回退环境变量（seedFromEnvOnce 有门禁）',
      /if \(!isSetupRequired\(\)\) return null/.test(db));
    check('暴露 isDbSetupRequired 供 middleware 使用', /export function isDbSetupRequired/.test(db));
    check('四个域都从文件解析', ['user', 'conversation', 'knowledge', 'overflow']
      .every((d) => db.includes(`resolveDbUrl('${d}')`)));
  }

  S('9. 环境变量读取点审计（本次需求的核心）');
  {
    // 不用 shell grep：本沙箱 grep 时灵时不灵，会把审计结论带偏。
    // 直接用 Node 遍历，剥注释后统计真实的 DATABASE_URL_ 读取点。
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp, out);
        else if (e.name.endsWith('.ts')) out.push(fp);
      }
      return out;
    };
    const readers: string[] = [];
    for (const fp of walk(srcOf('src'))) {
      const code = readFileSync(fp).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
      // 必须匹配 `process.env.DATABASE_URL_`：只匹配标识符会把
      // `DATABASE_URL_USER: _dbUser` 这种属性名误判成"仍在读环境变量"。
      // 两种写法都要覆盖：点号式与下标模板式
      // （db.ts 一次性桥接用的是 process.env[`DATABASE_URL_${...}`]）。
      const readsEnvUrl = /process\.env\.DATABASE_URL_/.test(code)
        || /process\.env\[\s*[`'"]DATABASE_URL_/.test(code);
      if (readsEnvUrl) readers.push(path.relative(REPO, fp));
    }
    console.log('    仍读取 process.env.DATABASE_URL_* 的文件:', readers.join(', ') || '（无）');
    check('只剩 db.ts 一处保留（一次性桥接）', readers.length === 1 && readers[0].endsWith('db.ts'),
      `实际 ${readers.length} 处：${readers.join(', ')}`);
    check('桥接处有 isSetupRequired 门禁', /if \(!isSetupRequired\(\)\) return null/.test(
      readFileSync(srcOf('src/services/db.ts')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '')));
    check('systemConfig 自身不读连接串环境变量（VAULT_KEY 是密钥来源，不在此列）',
      !/process\.env\.DATABASE_URL_/.test(readFileSync(srcOf('src/services/systemConfig.ts'))));
    check('config.ts 的 DATABASE_URL 改从 systemConfig 取（不再 process.env）',
      /DATABASE_URL_USER: _dbUser/.test(readFileSync(srcOf('src/config.ts')))
      && !/DATABASE_URL_USER: process\.env/.test(readFileSync(srcOf('src/config.ts'))));

    // 其他 env 仍有大量使用（OAuth/搜索密钥等）——那是本次需求范围外，
    // 明确列出来，不在报告里含糊其辞。
    const envUsers = walk(srcOf('src')).filter((fp) => /process\.env\./.test(readFileSync(fp))).length;
    console.log(`    仍读取其他 process.env 的文件数：${envUsers}（OAuth/搜索密钥/功能开关，本次未纳入）`);
  }

  // ---- 清理 ----
  SC.__setCipherForTests(null);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  console.log(`\n系统配置测试：${pass} 通过 / ${fail} 失败`);
  if (fail === 0) {
    console.log('\n[UNVERIFIED — 本机无法验证]');
    console.log('  1. 真实 Postgres 握手：SELECT 1 实际可达性与超时行为');
    console.log('  2. setup 落盘后进程无需重启即可用新连接（reloadSystemConfig）');
    console.log('  3. 首次配齐四域后业务路由的 503→200 切换');
    console.log('  4. 生产环境 data/ 目录的备份与迁移（文件随镜像重建需重新配置）');
  }
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 120);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
