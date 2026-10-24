// ================================================================
// 温度引擎「选择准确性」验证
// Run: npx tsx test/temperatureAccuracy.test.ts
//
// 背景：chat.ts 的温度输入原先全是写死常量，导致**不同消息可能拿到同一个
// 温度**（4 项信号退化成恒定偏移 +0.035）。本测试用真实消息走
// localClassify → computeTemperature，证明：
//   A. 语义不同的消息现在拿到**可区分**的温度（准确性真的改善了）
//   B. 高创造性任务温度显著高于低创造性任务（单调性在真实语料上成立）
//   C. 少数派语料（多任务/混合意图）不会崩溃
//   D. 本地分类是纯函数：重复结果一致、无 IO
// ================================================================

import { localClassify } from '../src/services/taskTaxonomy';
import { computeTemperature } from '../src/services/generationProfile';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = '') =>
  c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, d));
const S = (n: string) => console.log('\n=== ' + n + ' ===');

/** 复现 chat.ts 的组装方式（与线上同一路径）。 */
function tempFor(message: string): { t: number; creativity: number; tasks: string[]; accuracy: string; risk: string } {
  const md = localClassify(message);
  const input = {
    tasks: md.tasks.length ? md.tasks : ['answer'],
    creativity: typeof md.creativity === 'number' ? md.creativity : 2,
    accuracy: md.accuracy || 'medium',
    exploration: 0.5, diversity: 0.5, structure: 0.5, consistency: 0.5,
    risk: md.risk || 'low',
    verification: !!md.verification_required,
  } as any;
  const p = computeTemperature(input);
  return { t: p.temperature, creativity: md.creativity, tasks: md.tasks, accuracy: md.accuracy, risk: md.risk };
}

const CASES: { msg: string; label: string; expect: 'low' | 'mid' | 'high' }[] = [
  { msg: '帮我把这段话翻译成英文', label: '翻译（应低温）', expect: 'low' },
  { msg: '计算 347 乘以 28 等于多少', label: '数学计算（应低温）', expect: 'low' },
  { msg: '帮我 debug 这个报错 error', label: '代码调试（应低温）', expect: 'low' },
  { msg: '帮我审查这段代码 review', label: '代码审查（中低温）', expect: 'low' },
  { msg: '帮我总结一下这篇长文的要点', label: '摘要（应低温）', expect: 'low' },
  { msg: '帮我写一封产品上线邮件', label: '写作（应中温）', expect: 'mid' },
  { msg: '帮我写一篇产品简介文案', label: '文案（应中温）', expect: 'mid' },
  { msg: '帮我做一次头脑风暴，想一些创意', label: '头脑风暴（应高温）', expect: 'high' },
  { msg: '帮我brainstorm几个新功能idea', label: 'brainstorm（应高温）', expect: 'high' },
  { msg: '做一个产品规划 plan', label: '规划（中温）', expect: 'mid' },
];

S('A. 不同语义的消息拿到可区分的温度');
{
  const results = CASES.map((c) => ({ ...c, ...tempFor(c.msg) }));
  const distinct = new Set(results.map((r) => r.t.toFixed(4)));
  console.log('    实测分布：');
  for (const r of results) console.log(`      ${r.t.toFixed(2)}  creativity=${r.creativity}  ${r.label}`);
  check(`温度取值数 >= 5（而非全部挤在一个值上），实际 ${distinct.size}`,
    distinct.size >= 5, `实际仅 ${distinct.size} 种：${[...distinct].join(',')}`);

  // 关键对照：硬编码旧路径下「翻译」与「写文案」的 creativity 都是同源默认，
  // 现在两者必须不同
  const translate = tempFor(CASES[0].msg), copy = tempFor(CASES[6].msg);
  check('翻译 vs 文案 的 creativity 已区分（不再同值）',
    translate.creativity !== copy.creativity,
    `${translate.creativity} vs ${copy.creativity}`);
  check('且文案温度高于翻译温度', copy.t > translate.t, `${copy.t} vs ${translate.t}`);
}

S('B. 高低创造性的排序在真实语料上成立');
{
  const brainstorm = tempFor('帮我做一次头脑风暴，想一些创意').t;
  const translate = tempFor('帮我把这段话翻译成英文').t;
  const calc = tempFor('计算 347 乘以 28 等于多少').t;
  check('头脑风暴 > 翻译', brainstorm > translate, `${brainstorm} vs ${translate}`);
  check('头脑风暴 > 数学计算', brainstorm > calc, `${brainstorm} vs ${calc}`);
  check('低温组都在 0.5 以下', translate <= 0.5 && calc <= 0.5, `${translate}, ${calc}`);
  check('头脑风暴进入 exploratory 区间（>=1.0）', brainstorm >= 1.0, String(brainstorm));

  // 按 expect 分组统计：high 组必须整体高于 low 组
  const low = CASES.filter((c) => c.expect === 'low').map((c) => tempFor(c.msg).t);
  const high = CASES.filter((c) => c.expect === 'high').map((c) => tempFor(c.msg).t);
  const lowMax = Math.max(...low), highMin = Math.min(...high);
  check(`low 组最高 ${lowMax.toFixed(2)} < high 组最低 ${highMin.toFixed(2)}`,
    lowMax < highMin, `${lowMax} vs ${highMin}`);

  // ---- 已定位的准确性缺陷（曝光用，不中断套件） ----
  // 实测：头脑风暴(creativity=4) 只有 1.43，写作/文案(creativity=3) 却有 1.50，
  // 即「创作性更高的任务拿到更低温度」。根因在 TEMP_CALIBRATION 区间本身：
  //   creative_writing [1.10, 1.70] 的下限 高于 brainstorming [1.00, 1.50]，
  //   于是中等创造力的写作可以超过满创造力的头脑风暴。
  // 修正需要产品侧确定目标排序（不该由实现擅自改校准表），故此处只曝光。
  const writingCase = tempFor('帮我写一篇产品简介文案').t;
  const brainstormCase = tempFor('帮我做一次头脑风暴，想一些创意').t;
  const inverted = brainstormCase < writingCase;
  console.log(inverted
    ? `  WARN 校准表区间导致排序倒挂：brainstorming=${brainstormCase} < creative_writing=${writingCase}（待产品定序）`
    : `  OK  排序正常：brainstorming=${brainstormCase} >= creative_writing=${writingCase}`);
  if (inverted) {
    console.log('       TEMP_CALIBRATION 现状：creative_writing=[1.10,1.70] brainstorming=[1.00,1.50]');
    console.log('       建议方向：提高 brainstorming 上限或下调 creative_writing 下限，需业务确认');
  }
}

S('C. 边界语料不崩且仍有合理值');
{
  const weird = ['', '   ', 'asdfghjkl', '???', '🎉🎉🎉', '你好', 'a', '帮我同时翻译并写文案还要头脑风暴'];
  for (const w of weird) {
    const r = tempFor(w);
    check(`语料 ${JSON.stringify(w).slice(0, 24)} → 温度在 [0,2]`,
      Number.isFinite(r.t) && r.t >= 0 && r.t <= 2, String(r.t));
  }
  // 长消息（真实场景常见）
  const long = '帮我分析'.repeat(2000);
  const lr = tempFor(long);
  check('超长消息仍返回有效温度', Number.isFinite(lr.t) && lr.t > 0, String(lr.t));
}

S('D. 本地分类是纯函数（准确性不靠 IO）');
{
  const msg = '帮我写一篇产品简介文案';
  const a = JSON.stringify(localClassify(msg)), b = JSON.stringify(localClassify(msg));
  check('同消息分类结果一致（纯函数）', a === b, a.slice(0, 80) + ' vs ' + b.slice(0, 80));
  const before = JSON.stringify(localClassify(msg));
  for (let i = 0; i < 50; i++) { tempFor('帮我做一次头脑风暴，想一些创意'); }
  check('反复调用无状态污染', JSON.stringify(localClassify(msg)) === before);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
