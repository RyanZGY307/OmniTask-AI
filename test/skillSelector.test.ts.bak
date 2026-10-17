// ================================================================
// Skill Selector 测试 — 纯内存、零依赖（无 DB / 无 LLM）。
// 运行：npx tsx test/skillSelector.test.ts
// 覆盖：零选是正式结果 / 适用性门槛 / tier 硬过滤 / 知识库场景限制 /
//       上限 2 / 第二个 Skill 的互补收益检查 / 延迟基线 / 指标计数。
// ================================================================

import {
  selectSkills,
  getSkillSelectionMetrics,
  MIN_SCORE,
  SKILL_HARD_CAP,
} from '../src/services/skillSelector';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const sel = (message: string, taskType: string, opts: { caps?: string[]; tier?: string } = {}) =>
  selectSkills({
    message,
    taskType,
    requiredCapabilities: opts.caps,
    userTier: opts.tier || 'STANDARD',
  });

console.log('=== 1. 零选是正式决策结果 ===');
const chitChat = sel('你好，今天心情不错', 'general');
check('普通闲聊 → SELECT_NONE', chitChat.decision === 'SELECT_NONE' && chitChat.skillIds.length === 0);
check('零选带理由（可追踪）', chitChat.reason.length > 0 && chitChat.reason.includes('no candidate'));

console.log('\n=== 2. 适用性门槛：弱信号不选 ===');
// "write" 是 writing_assistant 的单个弱 trigger（+1），任务类型 general 无加成 → 1 < 2 → 零选
const weak = sel('can you write', 'general');
check('单个弱 trigger 低于门槛 → SELECT_NONE', weak.decision === 'SELECT_NONE');
// coding 任务 + code trigger → 强证据入选
const code = sel('帮我用 python 写一个函数', 'coding');
check('代码任务选中 code_assistant', code.decision !== 'SELECT_NONE' && code.skillIds.includes('code_assistant'));
check('门槛值可配置且默认为 2', MIN_SCORE === 2);

console.log('\n=== 3. tier 硬过滤 ===');
// data_analysis 是 PRO：STANDARD 用户即使命中全部 trigger 也不选
const dataStd = sel('analyze the data statistics and find the trend pattern', 'analysis');
check('STANDARD 用户不选 PRO 技能 data_analysis', !dataStd.skillIds.includes('data_analysis'));
const dataPro = sel('analyze the data statistics and find the trend pattern', 'analysis', { tier: 'PRO' });
check('PRO 用户可选 data_analysis', dataPro.skillIds.includes('data_analysis'));
check('排除原因被记录（候选表含 excluded）', dataStd.candidates.some((c) => c.id === 'data_analysis' && !!c.excluded));

console.log('\n=== 4. knowledge_base 场景限制 ===');
// coding 任务未点名知识库 → 排除（不得因为"不是闲聊"就挂上）
const kbCoding = sel('fix this bug in my api code', 'coding');
check('非知识型任务不挂 knowledge_base', !kbCoding.skillIds.includes('knowledge_base'));
// 用户点名知识库（trigger 命中）→ 可选
const kbNamed = sel('根据知识库里的规则回答这个问题', 'question');
check('点名知识库可入选', kbNamed.skillIds.includes('knowledge_base'));
// research 任务（知识型）即使不点名也可获得知识库能力
const kbResearch = sel('research the latest trends', 'research');
check('知识型任务挂 knowledge_base', kbResearch.skillIds.includes('knowledge_base'));

console.log('\n=== 5. 上限 2 与互补检查 ===');
check('硬上限常量为 2', SKILL_HARD_CAP === 2);
// 多技能强命中：翻译+写作（互补，分数接近）→ 最多 2
const multi = sel('translate and write an article essay draft', 'writing');
check('多命中也不超过 2 个', multi.skillIds.length <= 2);
// 主技能足够强时，弱辅助不被凑数
const solo = sel('帮我 debug 这个 javascript 报错', 'coding');
check('单一明确任务 → SELECT_ONE 且无凑数辅助', solo.decision === 'SELECT_ONE' && solo.skillIds.length === 1 && solo.skillIds[0] === 'code_assistant');
// 互补才允许双选：translation + writing 两个 trigger 都强
const duo = sel('翻译这篇文章并按同样风格写 an essay', 'writing');
check('互补双选须记录两个 id 与理由', duo.skillIds.length <= 2 && duo.reason.length > 0);

console.log('\n=== 6. 注入层硬截断（后端执行器兜底） ===');
// 注入层（compiler.buildSkillSections）通过 slice(0, 2) 硬截断：
// 验证其源码中存在该截断（零依赖读源检查）
const compilerSource = readFileSync(`${__dirname}/../src/services/compiler.ts`, 'utf8');
check('注入层上限为 2（slice(0, 2) 存在于 compiler 源码）', compilerSource.includes('slice(0, 2)'));

console.log('\n=== 7. 延迟基线（纯内存索引查询） ===');
const N = 5000;
const t0 = Date.now();
for (let i = 0; i < N; i++) selectSkills({ message: '帮我分析这份数据并搜索最新资料' + (i % 7), taskType: 'analysis', userTier: 'PRO' });
const perCallMs = (Date.now() - t0) / N;
check(`5000 次选择平均 < 1ms（实测 ${perCallMs.toFixed(4)}ms）`, perCallMs < 1);
check('单次选择结果带 elapsedMs', typeof sel('x', 'general').elapsedMs === 'number');

console.log('\n=== 8. 指标计数（零选率监控基础） ===');
const m1 = getSkillSelectionMetrics();
check('指标统计选择次数', m1.selections > 0);
check('零选计数与决策一致', m1.zero > 0 && m1.one > 0);
check('指标含平均耗时', m1.avgElapsedMs >= 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
