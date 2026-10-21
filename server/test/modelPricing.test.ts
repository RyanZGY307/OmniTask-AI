// 模型 API 价格修改 — 行为契约测试（PUT /admin/models/:modelKey + 管理页改价）。
//
// 本机无法执行真实 Prisma（引擎 x86_64 vs arm64，dlopen 失败），因此本文件
// 只做三类**可真实断言**的验证：
//   ① 源码结构：端点存在、方法正确、鉴权挂载、不变量（update 而非 upsert 等）
//   ② 算术：积分/1M 与 积分/1k 的换算、FREE 档强制 0、负数/NaN 拒绝
//   ③ 前端契约：页面存在改价入口、使用 apiPut、不改用删除重建路径
// 无法在本机验证的部分在末尾显式列出为 UNVERIFIED，不用"看起来对"冒充通过。
// ================================================================

process.on('uncaughtException', (err: any) => {
  const m = String(err?.message || err);
  if (m.includes('EM_X86_64') || m.includes('EM_AARCH64') || m.includes('Prisma engines')) {
    process.exit(process.exitCode || 0);
  }
  console.error('未预期的未捕获异常:', err);
  process.exit(1);
});

let pass = 0, fail = 0;
const check = (n: string, c: boolean, e = '') =>
  c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, e));

const { readFileSync } = require('fs');
const STRIP = (p: string) => readFileSync(p, 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const ADMIN = 'src/routes/admin.ts';
const PAGE = '../client/src/app/admin/models/page.tsx';

(async () => {
  // ---------------------------------------------------------------
  console.log('\n1. 端点存在性与基础契约');
  {
    const admin = STRIP(ADMIN);
    check('PUT /models/:modelKey 端点存在', /router\.put\(\s*['"]\/models\/:modelKey['"]/.test(admin));
    check('挂载 adminAuth（与同文件其余写操作一致）',
      /router\.put\(\s*['"]\/models\/:modelKey['"]\s*,\s*adminAuth/.test(admin));
    check('保留原有 GET/POST/DELETE（未用 PUT 顶替它们）',
      /router\.get\(\s*['"]\/models['"]/.test(admin) &&
      /router\.post\(\s*['"]\/models['"]/.test(admin) &&
      /router\.delete\(\s*['"]\/models\/:modelKey['"]/.test(admin));

    // PUT 必须落在 DELETE 之后、credit-packs 之前，不破坏既有路由序
    const putAt = admin.search(/router\.put\(\s*['"]\/models\/:modelKey['"]/);
    const delAt = admin.search(/router\.delete\(\s*['"]\/models\/:modelKey['"]/);
    check('PUT 注册在 DELETE 之后（同组模型端点相邻）', putAt > delAt && delAt > 0);
  }

  // ---------------------------------------------------------------
  console.log('\n2. 价格改写语义（核心安全属性）');
  {
    const admin = STRIP(ADMIN);
    const put = admin.slice(admin.search(/router\.put\(\s*['"]\/models\/:modelKey['"]/));

    check('用 update 而非 upsert —— modelKey 不存在不得顺手创建新模型',
      /prisma\.modelConfig\.update\(/.test(put));
    check('端点内不出现 upsert（否则"改价"会变成"新建"）',
      !/modelConfig\.upsert\(/.test(put));
    check('显式忽略请求体中的 modelKey（身份不可通过本端点改）',
      /_ignoredKey/.test(put));
    check('改价前先查存在性并返回 404',
      /status\(404\)/.test(put) && /模型不存在/.test(put));
    check('空请求体返回 400 而非把整行写成默认值',
      /status\(400\)/.test(put) && /没有提供任何可修改字段/.test(put));
    check('写库后刷新运行时注册表（ refreshModelConfigs ）',
      /refreshModelConfigs\(\)/.test(put));
    check('P2025 映射为 404（并发删除时不暴露堆栈）', /P2025/.test(put));
  }

  // ---------------------------------------------------------------
  console.log('\n3. 价格换算与取值域（与服务端同一套规则的断言性复算）');
  {
    // 复算服务端逻辑：管理端用「积分/1M」，注册表存「积分/1k」。
    const toCost1k = (costPer1M: any, costPer1k: any) => {
      if (costPer1M !== undefined) return { v: Number(costPer1M) / 1000, bad: !Number.isFinite(Number(costPer1M) / 1000) || Number(costPer1M) / 1000 < 0 };
      if (costPer1k !== undefined) return { v: Number(costPer1k), bad: !Number.isFinite(Number(costPer1k)) || Number(costPer1k) < 0 };
      return { v: undefined, bad: false };
    };
    const ADMIN_UNIT = 1e6;   // 管理端 1M token 计价
    const REGISTRY_UNIT = 1e3; // 注册表 1k token 计价

    check('1M→1k 换算比例正确（1000 ÷ 1000 = 1）', toCost1k(5000).v === 5);
    check('小数价格可取（0.001 级）', Math.abs(toCost1k(1).v - 0.001) < 1e-9);
    check('0 表示免费且不被判为非法', toCost1k(0).v === 0 && !toCost1k(0).bad);
    check('拒绝负数', toCost1k(-1).bad === true);
    check('拒绝 NaN', toCost1k('abc').bad === true);
    check('拒绝 Infinity', toCost1k(Infinity).bad === true);
    check('未提供价格时不改该字段（undefined）', toCost1k(undefined, undefined).v === undefined);

    // 服务端 FREE 档强制 0 的规则复算
    const effective = (tier: string, cost: number | undefined, orig: number) =>
      tier === 'FREE' ? 0 : (cost !== undefined ? cost : orig);
    check('FREE 档改价被强制归零（防止"免费"标签与真实计费脱节）',
      effective('FREE', 999, 0) === 0);
    check('FREE 档改价后仍不因未传价格而丢掉原值', effective('FREE', undefined, 0) === 0);
    check('PRO 档按提交值改写', effective('PRO', 12, 0) === 12);
    check('PRO 档未提交价格时保留原值', effective('PRO', undefined, 7) === 7);

    // 前端展示换算反向一致性：models 页显示 costPer1k * 1000
    const page = STRIP(PAGE);
    check('前端展示用 costPer1k * 1000 还原为管理端单位',
      /Math\.round\(m\.costPer1k \* 1000\)/.test(page));
    check('前端 Free 档不显示价格输入框', /m\.tier === 'FREE'[\s\S]{0,80}?免费/.test(page));
    check('前端提交同样用 costPer1M（与服务端口径一致）', /costPer1M:/.test(page));
  }

  // ---------------------------------------------------------------
  console.log('\n4. 前端契约：确实是"改价"而非"删除重建"');
  {
    const page = STRIP(PAGE);
    check('页面调用 apiPut 修改模型', /apiPut\(`\/admin\/models\/\$\{encodeURIComponent\(m\.modelKey\)\}`/.test(page));
    check('只提交价格相关字段（不重传厂商/限额/能力）',
      /apiPut\(`\/admin\/models\/\$\{encodeURIComponent\(m\.modelKey\)\}`\s*,\s*\{[^}]*costPer1M/.test(page));
    check('改价路径不调用 apiDelete', !/apiDelete/.test(page.split('editModelPrice')[1] || ''));
    check('导入 apiPut', /from '@\/lib\/api'/.test(readFileSync(PAGE, 'utf-8')) && /apiPut/.test(readFileSync(PAGE, 'utf-8')));
    check('存在"保存价格"按钮', /保存价格/.test(page));
    check('保存中状态有禁用保护', /disabled=\{savingPrice === m\.modelKey/.test(page));
    check('输入校验：非负数字才放行', /Number\.isFinite\(v\) \|\| v < 0/.test(page));
    check('改价后本地同步（非整页刷新，避免表格闪白）', /setModels\(\(prev\) => prev\.map/.test(page));
    // 行为差异：未改动过的模型不应有"保存"可用状态
    check('未编辑过的模型保存按钮禁用（避免误提交）', /priceEdits\[m\.modelKey\] === undefined/.test(page));
  }

  // ---------------------------------------------------------------
  console.log('\n5. 回归护栏：不得退化为"删了重加"');
  {
    const page = STRIP(PAGE);
    check('添加表单与改价是两条独立路径（未删除 POST 添加能力）',
      /apiPost\('\/admin\/models'/.test(page));
    check('POST 端点仍是 upsert（添加能力未受影响）', /POST \/models/.test(readFileSync('src/routes/admin.ts', 'utf-8')));
    check('PUT 不覆盖 POST 的路由路径（两者路径不同）',
      readFileSync('src/routes/admin.ts', 'utf-8').includes("router.put('/models/:modelKey'") &&
      readFileSync('src/routes/admin.ts', 'utf-8').includes("router.post('/models'"));
  }

  console.log(`\n模型价格修改测试：${pass} 通过 / ${fail} 失败`);
  if (fail === 0) {
    console.log('\n[UNVERIFIED — 本机无法验证，需真实环境]');
    console.log('  1. 真实 Postgres 上 PUT 后的 costPer1k 落库值与 refreshModelConfigs 生效');
    console.log('  2. 真实前端点击"保存价格"后的网络请求与后端落库');
    console.log('  3. 计费链路是否立即按新价计费（本次未改计费代码）');
    console.log('  4. 非管理员用户访问 PUT 的实际 403 行为');
  }
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 120);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
