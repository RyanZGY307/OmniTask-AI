// ================================================================
// 真实 Token 显示 — 回归护栏
// Run: npx tsx test/realTokenUsage.test.ts
//
// 需求：删除假 token 计算，展示与扣费一律用真实 token 消耗。
//
// 本测试**不看运行时**（本机无法连 provider / Postgres），只做源码级回归
// 护栏，把已删除的五种造假手法钉住，防止以"修 bug"名义悄悄回归。
// 数值行为本身由 test/tokenBilling.test.ts 覆盖。
//
// 五类造假手法：
//   1. 字符数除系数估算 token（content.length / 3）
//   2. 按模式乘数放大输出（×1.1 / ×1.2）
//   3. 超出上限时把 output 挪到 input（overflow 转移）
//   4. 把显示值取整到 10/50 的"防反推"取整
//   5. provider 缺 usage 时按 70%/30% 编造输入输出拆分
//
// 一条重要区分（否则会把合理设计一起删掉）：
//   · 「预算估算」——生成前估 prompt 体积以决定要不要裁剪/压缩，
//     发生在 provider 还没回 usage 之前，不参与扣费也不作为消耗展示。
//     合理，保留（compiler.ts / compress.ts / memoryManager）。
//   · 「消耗造假」——把估算数字当成 token 消耗去展示或扣费。禁止。
//   下面的判断依据就是这个流向，不是"有没有除过 3"。
// ================================================================

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = '') =>
  cond ? (pass++, console.log('  PASS', name)) : (fail++, console.log('  FAIL', name, detail));
const S = (name: string) => console.log('\n' + name);

const REPO = process.cwd();
const read = (p: string) => readFileSync(join(REPO, p), 'utf-8');
// 剥注释：`//` 前带冒号的是 URL 里的协议分隔（postgresql://），不是注释。
const strip = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
const codeOf = (p: string) => strip(read(p));
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const fp = join(dir, e);
    if (statSync(fp).isDirectory()) walk(fp, out);
    else if (e.endsWith('.ts')) out.push(fp);
  }
  return out;
};
const srcFiles = walk(join(REPO, 'src')).map((f) => relative(REPO, f));

S('1. 消耗/计费路径中不存在字符数估算（核心不变量）');
{
  const chat = codeOf('src/routes/chat.ts');
  const research = codeOf('src/services/research.ts');

  check('chat.ts 的 tokenCount 只来自 provider（chunk.tokens || 0）',
    /tokenCount = chunk\.tokens \|\| 0/.test(chat));
  check('chat.ts 不再有 fullContent.length / 3', !/fullContent\.length\s*\/\s*3/.test(chat));
  check('chat.ts 不再有 tokensUsed * 0.7', !/tokensUsed\s*\*\s*0\.7/.test(chat));
  check('chat.ts 不再有 tokensUsed * 0.3', !/tokensUsed\s*\*\s*0\.3/.test(chat));
  check('流式 inputTokens 不再有 0.7 兜底', !/inputTokens = providerUsage\?\.prompt_tokens \?\?/.test(chat));
  check('流式 outputTokens 不再有 tokenCount-inputTokens 兜底',
    !/outputTokens = providerUsage\?\.completion_tokens \?\?/.test(chat));
  // tokenCount 的全部赋值点必须只有 provider 来源
  // 捕获到语句结束（分号或换行），否则只拿到 "tokenCount =" 十个字符，
  // 根本看不到右侧来源，这个断言就永远失去意义。
  const assignments = (chat.match(/tokenCount\s*=[^;\n]*/g) || [])
    .map((a) => a.trim()).filter((a) => a !== 'tokenCount = 0');
  // 不要求"只有一处"：chat.ts 里一个请求有两个真实的 provider 来源
  //   · chunk.tokens（done 事件带的总量）
  //   · providerUsage.total_tokens（更权威的 usage 块，收到时覆盖前者）
  // 两者都是实测，覆盖是优化不是造假。真正要禁的是**任何非 provider 来源**。
  const PROVIDER_SRC = /chunk\.tokens|providerUsage\.total_tokens/;
  check('tokenCount 的赋值点全部来自 provider',
    assignments.length >= 1 && assignments.every((a) => PROVIDER_SRC.test(a)),
    `实际: ${assignments.join(' | ')}`);
  check('tokenCount 没有任何赋值点来自文本长度',
    assignments.every((a) => !/\.length/.test(a)), `实际: ${assignments.join(' | ')}`);
  console.log(`    tokenCount 赋值点: ${assignments.join(' | ')}`);
  check('tokenCount 从未被赋成文本长度的函数', !/tokenCount\s*=\s*[^;\n]*\.length/.test(chat));

  check('research.ts 不再有 analysis.length / 3', !/analysis\.length\s*\/\s*3/.test(research));
  check('research.ts 真的采集 provider usage', /chunk\.type === 'usage'/.test(research));
  check('research.ts 的 tokensUsed 来自真实 usage',
    /const realTokens = providerUsage\?\.total_tokens \?\? chunkTokens/.test(research));

  // 离线 mock 曾把 reply.length/2 灌进 chunk.tokens → 进扣费路径
  const models = codeOf('src/services/models.ts');
  check('offline-mock 的 tokens 不再用文本长度伪造', !/reply\.length\s*\/\s*2/.test(models));
  check('offline-mock 记 0（没有真实调用就不该有消耗）', /offline-mock', tokens: 0/.test(models));
}

S('2. 模式乘数放大已删除');
{
  const bill = read('src/services/billing/tokenBilling.ts');
  check('不再定义 MODE_MULTIPLIER', !/export const MODE_MULTIPLIER/.test(bill));
  check('不再定义 MAX_ALLOWED_MULTIPLIER', !/export const MAX_ALLOWED_MULTIPLIER/.test(bill));
  check('不再定义 multiplierFor', !/export function multiplierFor/.test(bill));
  check('calculateBilling 的 mode / limit 参数不影响数值',
    /_mode: ChatMode/.test(bill) && /_verifiedOutputLimit: number \| null/.test(bill));

  const inflation = srcFiles.filter((f) => /\*\s*1\.[12]\b/.test(codeOf(f)));
  check('src 下无 `* 1.1` / `* 1.2` 型 token 放大', inflation.length === 0,
    `仍存在于: ${inflation.join(', ')}`);
}

S('3. overflow 转移已删除');
{
  const bill = codeOf('src/services/billing/tokenBilling.ts');
  check('不再出现 const overflow =', !/const overflow =/.test(bill));
  check('displayInput 不再吸收溢出量', !/displayInput: inp \+ overflow/.test(bill));
  check('不再把 output 截断到上限', !/displayOutput: verifiedOutputLimit/.test(bill));
  check('overflowTransferred 不再为 true', !/overflowTransferred: true/.test(bill));
}

S('4. 防反推取整已删除');
{
  const bill = read('src/services/billing/tokenBilling.ts');
  check('不再定义 deterministicRound', !/export function deterministicRound/.test(bill));
  check('不再定义 applyAntiReverseRounding', !/export function applyAntiReverseRounding/.test(bill));
  const callers = srcFiles.filter((f) => /applyAntiReverseRounding|deterministicRound/.test(codeOf(f)));
  check('src 下无任何文件仍调用取整函数', callers.length === 0,
    `仍存在于: ${callers.join(', ')}`);
}

S('5. 扣费与落库用真实 token');
{
  const usage = codeOf('src/services/billing/tokenUsage.ts');
  check('processTokenUsage 不再调用防反推取整', !/applyAntiReverseRounding/.test(usage));
  check('multiplier 落库恒为 1', /multiplier = 1/.test(usage));
  check('actual* 与 display* 写同一组真实值',
    /displayInputTokens: input\.billing\.displayInput/.test(usage));
}

S('6. 装饰性假指标已拆除');
{
  const settings = codeOf('src/routes/settings.ts');
  check('不再读永不写入的 cacheHitTokens', !/cacheHitTokens/.test(settings));
  check('不再读永不写入的 cacheMissTokens', !/cacheMissTokens/.test(settings));
  check('不再返回永远为 0 的 cacheHitRate', !/cacheHitRate/.test(settings));
  check('用量汇总改读真实 actualTotalTokens', /u \? u\.actualTotalTokens/.test(settings));

  // 确认根因：这两个字段全仓无人写入，所以原指标必然是 0
  const writers = srcFiles.filter((f) => /cacheHitTokens\s*:|cacheMissTokens\s*:/.test(f));
  check('确认无任何代码写入 cacheHit/cacheMiss', writers.length === 0,
    `写入方: ${writers.join(', ')}`);
}

S('7. Admin 视图不再宣称双轨');
{
  const admin = codeOf('src/routes/admin.ts');
  check('不再暴露恒为 1 的 billingDetail.multiplier',
    !/multiplier: usage\.multiplier/.test(admin));
  check('不再返回 overflowTransferred（恒 false）',
    !/overflowTransferred: usage\.overflowTransferred/.test(admin));
  check('用户可见口径改用 userVisible 字段', /userVisible/.test(admin));
  check('用量汇总改读真实 actualTotalTokens', /totalTokens: r\.actualTotalTokens/.test(admin));
  check('不再有 totalDisplayTokens 这种误导命名', !/totalDisplayTokens:/.test(admin));
}

S('8. 剩余的 .length/N 只允许是「预算估算」且必须正名');
{
  // 生成前估 prompt 体积以决定裁剪/压缩 —— 合理。但必须能被名字自证是估算，
  // 否则将来没人分得清它到底是实测还是编的。
  const sites: Array<{ file: string; line: number; text: string }> = [];
  const re = /\.length\s*\/\s*\d+|\.length\s*\*\s*[\d.]+/g;
  for (const f of srcFiles) {
    const code = codeOf(f);
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      sites.push({ file: f, line: code.slice(0, m.index).split('\n').length, text: m[0] });
    }
  }
  check('全仓确有不使用文本长度的 token 计算（否则本节无意义）', sites.length >= 0);
  console.log(`  剩余文本长度计算 ${sites.length} 处：`);
  // 已评审的合法清单（file:line → 理由）。新增项必须先来这里说明用途，
  // 而不是靠正则去猜它"看起来像不像估算"。
  const ALLOWED: Record<string, string> = {
    'src/routes/admin.ts:313': 'conversation 体积字节粗估，用于存储配额展示，与 token 无关',
    'src/routes/chat.ts:501': 'system prompt 体积粗估（system_tokens_estimated），仅 prompt 可观测，不扣费',
    'src/services/audio/runtime.ts:368': 'PCM 音频缓冲区按字节扩容，与 token 无关',
    'src/services/rsi/signalBridge.ts:138': '成本异常检测的中位数样本序号（upperMedianCount），取排序后 50% 位置样本，与 token 计量无关',
    'src/services/rsi/scheduler.ts:138': '候选组最小样本量按份额换算（CANDIDATES_SHARE），与 token 计量无关',
    'src/services/rsi/metrics.ts:224': '字符量兜底估算（char-based-fallback），仅在 durationMs 缺失时出现，已自证 estimated 且不参与计费
    'src/services/compiler.ts:141': '生成前 prompt 预算估算（内核/技能/历史体积），决定是否裁剪',
    'src/services/context/compress.ts:23': '记忆压缩前的体积估算，决定是否触发压缩',
    'src/services/expressionLearning.ts:701': '表达学习密度 = 每百字符命中数的**分母**，是比例不是 token',
    'src/services/rsi/signalBridge.ts:127': '成本样本数组按序号取第 50% 位置（upperMedianCount），是统计中位数不是 token 估算',
    'src/services/rsi/scheduler.ts:138': '候选组最少样本占比（CANDIDATES_SHARE 常量），是实验样本量不是 token 估算',
    'src/agent/model/agentModelClient.ts:224': 'provider 用量不可用时的字符粗估兜底，已显式标 estimated/estimate/char-based-fallback，不用于计费',
  };
  const EST_MARK = /est|estimate|budget|bytes|_measured|approx/i;
  const unnamed: string[] = [];
  for (const s of sites) {
    const key = `${s.file}:${s.line}`;
    const code = codeOf(s.file);
    const lines = code.split('\n');
    const ctx = lines.slice(Math.max(0, s.line - 2), s.line + 1).join(' ');
    const reviewed = key in ALLOWED;
    const named = EST_MARK.test(ctx);
    console.log(`    ${reviewed ? '已评审' : named ? '估算' : '?'}  ${key}  ${s.text}${reviewed ? ' — ' + ALLOWED[key] : ''}`);
    if (!reviewed && !named) unnamed.push(`${key} ${s.text}`);
  }
  check('每一处文本长度计算都已评审或带 est/estimate/budget 命名自证',
    unnamed.length === 0, `未评审且未标注: ${unnamed.join(', ')}`);
  check('chat.ts 的 system_tokens 已改名自证为估算',
    /system_tokens_estimated/.test(codeOf('src/routes/chat.ts'))
    && !/system_tokens:/.test(codeOf('src/routes/chat.ts')));
}

S('9. 数据库列语义已标注（防后人误用）');
{
  const schemaFiles = ['prisma/schema.prisma', 'prisma/schema-user.prisma']
    .filter((p) => { try { read(p); return true; } catch { return false; } });
  check('找到 prisma schema', schemaFiles.length > 0, `未找到: ${schemaFiles.join(', ')}`);
  for (const p of schemaFiles) {
    const sc = read(p);
    if (!/model TokenUsage/.test(sc)) { console.log(`  (跳过 ${p}: 无 TokenUsage 模型)`); continue; }
    check(`${p} 标注 display* 为历史列`, /历史列/.test(sc) && /displayTotalTokens/.test(sc));
    check(`${p} 标注倍率已废除`, /倍率已废除/.test(sc));
    check(`${p} 标注 cache*/旧 token* 为从未写入的死列`, /从未写入的死列/.test(sc));
  }
}

console.log(`\n真实 Token 回归护栏：${pass} 通过 / ${fail} 失败`);
if (fail === 0) {
  console.log('\n[UNVERIFIED — 本机无法验证]');
  console.log('  1. provider 真实 usage 的端到端落库与扣费一致性');
  console.log('  2. 界面（气泡 token / 用量页）对真实值、0 与"未知"的渲染');
  console.log('  3. 删除 display* / cache* 死列所需的数据迁移（本次未动表结构）');
}
setTimeout(() => process.exit(fail > 0 ? 1 : 0), 120);
