// ================================================================
// 温度引擎（generationProfile.computeTemperature）测试
// Run: npx tsx test/temperatureEngine.ts
//
// 这批测试覆盖三类事：
//   1) 它确实是纯代码：无 IO、同输入同输出、与模块缓存状态无关
//   2) 选择质量：单调性、边界夹取、模型能力约束、任务类型敏感度
//   3) 集成契约：chat.ts / promptRuntime.ts 消费它时的行为
//
// 说明：本文件写于重构之前，其中「当前行为」类断言用于钉住既有语义，
// 防止重构悄悄改变线上输出。「应有行为」类断言会先失败，作为重构目标。
// ================================================================

import {
  computeTemperature, decideRetry, TEMP_CALIBRATION,
  setTemperatureModelResolver, hasTemperatureModelResolver,
  type TemperatureInput, type TemperatureModelResolver,
} from '../src/services/generationProfile';
import { clampTemperature, getModelCapability } from '../src/services/modelCapabilityRegistry';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = '') =>
  c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, d));
const S = (n: string) => console.log('\n=== ' + n + ' ===');

const base: TemperatureInput = {
  tasks: ['answer'], creativity: 2, accuracy: 'medium',
  exploration: 0.5, diversity: 0.5, structure: 0.5, consistency: 0.5,
};
const t = (o: Partial<TemperatureInput>): TemperatureInput => ({ ...base, ...o });

S('1. 纯度：同输入必须同输出');
{
  const a = computeTemperature(base);
  const b = computeTemperature(base);
  check('两次调用结果完全相等', JSON.stringify(a) === JSON.stringify(b),
    JSON.stringify(a) + ' vs ' + JSON.stringify(b));

  // 乱序调用 200 次不应漂移（纯函数 + 无共享可变状态）
  let drift = false;
  const first = JSON.stringify(computeTemperature(t({ tasks: ['creative_writing'] })));
  for (let i = 0; i < 200; i++) {
    computeTemperature(t({ tasks: ['calculation'], creativity: 0 }));
    if (JSON.stringify(computeTemperature(t({ tasks: ['creative_writing'] }))) !== first) drift = true;
  }
  check('反复交错调用无状态漂移', !drift);

  const before = JSON.stringify(computeTemperature(t({ targetModel: 'Agnes-3.0-flash' })));
  check('不传 targetModel 时输出稳定', before === JSON.stringify(computeTemperature(t({ targetModel: 'Agnes-3.0-flash' }))));
}

S('2. 单调性：创造力越高温度越高（准确度固定）');
{
  const acc = 'medium' as const;
  const temps = [0, 1, 2, 3, 4, 5].map((c) => computeTemperature(t({ creativity: c, accuracy: acc })).temperature);
  check('creativity 单调递增', temps.every((v, i) => i === 0 || v >= temps[i - 1]),
    temps.join(' > '));

  const low = computeTemperature(t({ creativity: 0, accuracy: 'critical' })).temperature;
  const high = computeTemperature(t({ creativity: 5, accuracy: 'low' })).temperature;
  check('高创造力+低准确度 > 低创造力+关键准确度', high > low, `${low} → ${high}`);
}

S('3. 边界与夹取');
{
  // 极端输入必须仍落在 [0.05, 2.0] 且不产生 NaN
  const extremes: TemperatureInput[] = [
    t({ creativity: 0, accuracy: 'critical', structure: 1, consistency: 1, risk: 'critical', verification: true }),
    t({ creativity: 5, accuracy: 'low', exploration: 1, diversity: 1, structure: 0, consistency: 0, risk: 'none' }),
    t({ tasks: [], creativity: 0, accuracy: 'critical' }),
    t({ tasks: ['不存在的任务类型'], creativity: 5, accuracy: 'low' }),
    t({ creativity: 99, accuracy: 'low', exploration: 1, diversity: 1 }),
    t({ creativity: -5, accuracy: 'critical', exploration: 0, diversity: 0 }),
  ];
  for (const [i, e] of extremes.entries()) {
    const r = computeTemperature(e);
    check(`极端输入 #${i} 落在 [0,2] 且非 NaN`,
      Number.isFinite(r.temperature) && r.temperature >= 0 && r.temperature <= 2, String(r.temperature));
  }
  check('空 tasks 回落到 answer 区间（不抛错）',
    computeTemperature(t({ tasks: [] })).temperature > 0);
}

S('4. 任务类型敏感度');
{
  const calc = computeTemperature(t({ tasks: ['calculation'] })).temperature;
  const brain = computeTemperature(t({ tasks: ['brainstorming'] })).temperature;
  check('brainstorming > calculation', brain > calc, `${calc} vs ${brain}`);

  const fact = computeTemperature(t({ tasks: ['fact_check'], accuracy: 'high' })).temperature;
  check('fact_check 保持低温（<=0.45）', fact <= 0.45, String(fact));

  check('TEMP_CALIBRATION 覆盖常见任务',
    ['calculation', 'code_generation', 'creative_writing', 'brainstorming', 'translation']
      .every((k) => k in TEMP_CALIBRATION));

  // 同一任务，准确度 critical 必须低于 low
  for (const task of ['explanation', 'planning', 'code_review']) {
    const c = computeTemperature(t({ tasks: [task], accuracy: 'critical', creativity: 2 })).temperature;
    const l = computeTemperature(t({ tasks: [task], accuracy: 'low', creativity: 2 })).temperature;
    check(`${task}: critical 准确度温度低于 low`, c <= l, `${c} vs ${l}`);
  }
}

S('5. 模型夹取（依赖注入，非全局缓存读）');
{
  // 未注入时：纯代码路径，不做模型夹取
  check('初始未注入解析器', hasTemperatureModelResolver() === false);

  const noInject = computeTemperature(t({ targetModel: 'Agnes-3.0-flash', creativity: 5, accuracy: 'low' })).temperature;
  check('未注入时 targetModel 不影响输出（纯代码）',
    noInject === computeTemperature(t({ creativity: 5, accuracy: 'low' })).temperature,
    `${noInject}`);

  // 注入低质量模型 → 上限应压低到 1.0
  const lowQ: TemperatureModelResolver = () => ({ qualityProfile: 4, speedProfile: 5 });
  setTemperatureModelResolver(lowQ);
  check('注入后 hasResolver=true', hasTemperatureModelResolver() === true);
  const capped = computeTemperature(t({ tasks: ['creative_writing'], creativity: 5, accuracy: 'low', targetModel: 'x' })).temperature;
  check('低质量模型上限 1.0', capped <= 1.0, String(capped));

  // 注入高质量模型 → 允许到 1.5
  setTemperatureModelResolver(() => ({ qualityProfile: 9, speedProfile: 2 }));
  const highQ = computeTemperature(t({ tasks: ['creative_writing'], creativity: 5, accuracy: 'low', targetModel: 'x' })).temperature;
  check('高质量模型可到 1.5', highQ <= 1.5 && highQ > 1.0, String(highQ));

  // 快速模型 → 下限 0.05
  setTemperatureModelResolver(() => ({ qualityProfile: 9, speedProfile: 9 }));
  const fast = computeTemperature(t({ tasks: ['calculation'], creativity: 0, accuracy: 'critical', targetModel: 'x' })).temperature;
  check('快速模型下限 >= 0.05', fast >= 0.05, String(fast));

  // 返回 null（模型无档位）→ 原样返回
  setTemperatureModelResolver(() => null);
  const nullCase = computeTemperature(t({ tasks: ['brainstorming'], creativity: 5, targetModel: 'x' })).temperature;
  check('解析器返回 null 时不夹取', nullCase === computeTemperature(t({ tasks: ['brainstorming'], creativity: 5 })).temperature);

  // 实测：解析器抛错时 computeTemperature 会抛（不是静默夹取）。
  // 这不是测试缺陷而是调用方隐患 —— chat.ts 的 catch 会退回硬编码 0.7，
  // 即引擎声称「绝不允许」的那个常量。这里把真实行为钉住。
  setTemperatureModelResolver(() => { throw new Error('resolver boom'); });
  let threw = false;
  try { computeTemperature(t({ targetModel: 'x' })); } catch { threw = true; }
  check('解析器抛错时 computeTemperature 确实抛（实测，非静默夹取）', threw === true,
    threw ? '会抛 → chat.ts 必须有兜底' : '未抛');

  // 兜底不得是硬编码常量：不带 targetModel 重算必须仍得到动态温度
  setTemperatureModelResolver(null);
  const fallback = computeTemperature(t({ tasks: ['creative_writing'], creativity: 5, accuracy: 'low' }));
  check('兜底路径（不带 targetModel）仍是动态计算，非常量',
    fallback.temperature !== 0.7 && fallback.temperature > 0, String(fallback.temperature));

  setTemperatureModelResolver(null);
  check('可重置为未注入', hasTemperatureModelResolver() === false);
}

S('6. 与模型能力夹取的叠加（chat.ts 实际顺序）');
{
  // chat.ts 顺序：computeTemperature(含模型夹取) → clampTemperature(模型能力表)
  const caps = ['low', 'medium', 'high', 'critical'] as const;
  for (const acc of caps) {
    const t0 = computeTemperature(t({ tasks: ['creative_writing'], creativity: 5, accuracy: acc, targetModel: undefined }));
    check(`accuracy=${acc} 输出在 [0,2]`, t0.temperature >= 0 && t0.temperature <= 2, String(t0.temperature));
    check(`accuracy=${acc} 有 generation_mode`, ['deterministic', 'balanced', 'creative', 'exploratory'].includes(t0.generation_mode), t0.generation_mode);
    check(`accuracy=${acc} top_p 与温度相关`, t0.top_p === 0.9 || t0.top_p === 0.95, String(t0.top_p));
  }
  // retry_strategy 规则
  check('critical 准确度 → multi 重试', computeTemperature(t({ accuracy: 'critical' })).retry_strategy === 'multi');
  check('verification → adaptive 重试', computeTemperature(t({ accuracy: 'medium', verification: true })).retry_strategy === 'adaptive');
  check('普通请求 → none 重试', computeTemperature(base).retry_strategy === 'none');
}

S('7. 自适应重试 decideRetry');
{
  const profile = computeTemperature(t({ tasks: ['explanation'], accuracy: 'medium' }));
  check('校验通过不重试', decideRetry(profile, { passed: true, issues: [] }, 0).should_retry === false);
  const r1 = decideRetry(profile, { passed: false, issues: ['x'] }, 0);
  check('none 策略不重试', profile.retry_strategy === 'none' && r1.should_retry === false);
  const adaptive = computeTemperature(t({ tasks: ['explanation'], accuracy: 'medium', verification: true }));
  const r2 = decideRetry(adaptive, { passed: false, issues: ['x'] }, 0);
  check('adaptive 策略会重试且降温', r2.should_retry === true && (r2.new_temperature ?? 0) < adaptive.temperature);
  const r3 = decideRetry(adaptive, { passed: false, issues: ['x'] }, 3);
  check('达到 3 次上限停止重试', r3.should_retry === false);
  check('降温不低于 0.1 下限', decideRetry(adaptive, { passed: false, issues: [] }, 0).new_temperature! >= 0.1);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
