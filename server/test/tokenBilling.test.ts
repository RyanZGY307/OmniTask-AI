// ================================================================
// Token Billing — 单轨（真实 token）测试
// Run: npx tsx test/tokenBilling.test.ts
//
// 覆盖：
//   · calculateBilling 在任何模式下都原样返回真实 token（无放大）
//   · overflow 恒为 false / 0（转移逻辑已删）
//   · 负数 / NaN / 小数被拦住，但不被"美化"
//   · deductCredits 按真实 token 换算，而非放大后的中间值
//   · mode 仍是合法元数据，但不影响任何数值
//   · 回归护栏：被删除的造假符号不得重新导出
// ================================================================

import * as B from '../src/services/billing/tokenBilling';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const modes = ['fast', 'standard', 'thinking'] as const;

// ==================== 1. 无放大 ====================
console.log('\n=== 1. 所有模式下都不放大 ===');
{
  for (const m of modes) {
    const r = B.calculateBilling(4000, 2000, m, 8192);
    check(`${m}: output 原样 2000`, r.displayOutput === 2000, `got ${r.displayOutput}`);
    check(`${m}: input 原样 4000`, r.displayInput === 4000, `got ${r.displayInput}`);
    check(`${m}: total 原样 6000`, r.displayTotal === 6000, `got ${r.displayTotal}`);
  }
  // 曾经的假值：standard 会给 2200，thinking 会给 2400。
  // 这里断言它们**不再是**这些数 —— 即放大确已消失。
  check('standard 不再是 2200（旧 ×1.1 放大）',
    B.calculateBilling(4000, 2000, 'standard', 8192).displayOutput !== 2200);
  check('thinking 不再是 2400（旧 ×1.2 放大）',
    B.calculateBilling(4000, 2000, 'thinking', 8192).displayOutput !== 2400);
}

// ==================== 2. overflow 已废除 ====================
console.log('\n=== 2. overflow transfer 已删除 ===');
{
  const r = B.calculateBilling(4000, 8000, 'thinking', 8192);
  check('output 不被截到上限', r.displayOutput === 8000, `got ${r.displayOutput}`);
  check('input 不吸收溢出量', r.displayInput === 4000, `got ${r.displayInput}`);
  check('overflowTransferred 恒 false', r.overflowTransferred === false);
  check('overflowAmount 恒 0', r.overflowAmount === 0);
  // 旧代码：displayInput=5408, displayOutput=8192, displayTotal=13600
  check('不再出现旧假值 displayInput=5408', r.displayInput !== 5408);
  check('不再出现旧假值 displayTotal=13600', r.displayTotal !== 13600);
  check('total === input + output', r.displayTotal === r.displayInput + r.displayOutput);
}

// ==================== 3. 防反推取整已删除 ====================
console.log('\n=== 3. display 值不再被取整 ===');
{
  // 旧 deterministicRound 会把 1234 抬到 1250、123 抬到 130。
  const r = B.calculateBilling(1234, 123, 'standard', null);
  check('input 保持 1234（不再进位到 1250）', r.displayInput === 1234, `got ${r.displayInput}`);
  check('output 保持 123（不再进位到 130）', r.displayOutput === 123, `got ${r.displayOutput}`);
  const big = B.calculateBilling(12345, 54321, 'thinking', 8192);
  check('大值不被取整到 50 的倍数', big.displayTotal === 66666, `got ${big.displayTotal}`);
}

// ==================== 4. 归一化与守卫 ====================
console.log('\n=== 4. 归一化 & 数值守卫 ===');
{
  check('normalize unknown -> fast', B.normalizeMode('bogus') === 'fast');
  check('normalize null -> fast', B.normalizeMode(null) === 'fast');
  check('normalize undefined -> fast', B.normalizeMode(undefined) === 'fast');
  check('normalize standard ok', B.normalizeMode('standard') === 'standard');
  check('normalize thinking ok', B.normalizeMode('thinking') === 'thinking');
  check('可归纳的模式名', ['fast', 'standard', 'thinking'].includes(B.normalizeMode('thinking')));

  const neg = B.calculateBilling(-100, -50, 'standard', 8192);
  check('负输入被挡为 0', neg.displayInput === 0 && neg.displayOutput === 0);
  const nan = B.calculateBilling(Number.NaN, Number.NaN, 'standard', null);
  check('NaN 被挡为 0', nan.displayTotal === 0);
  const frac = B.calculateBilling(100.9, 50.1, 'standard', 8192);
  check('小数向下取整（不四舍五入）',
    frac.displayInput === 100 && frac.displayOutput === 50,
    `got ${frac.displayInput}/${frac.displayOutput}`);
  check('limit=-1 不影响结果', B.calculateBilling(10, 20, 'thinking', -1).displayTotal === 30);
  check('limit=null 不影响结果', B.calculateBilling(10, 20, 'thinking', null).displayTotal === 30);
}

// ==================== 5. 扣费按真实 token ====================
console.log('\n=== 5. deductCredits 用真实 token ===');
{
  // 同一模型、同一组真实 token，三种模式必须扣同样的积分。
  const real = B.calculateBilling(4000, 2000, 'standard', 8192);
  const realFast = B.calculateBilling(4000, 2000, 'fast', 8192);
  const realThink = B.calculateBilling(4000, 2000, 'thinking', 8192);
  const cStd = B.deductCredits(real, 'agnes-3.0-flash');
  check('standard 与 fast 扣费相同', cStd === B.deductCredits(realFast, 'agnes-3.0-flash'));
  check('standard 与 thinking 扣费相同', cStd === B.deductCredits(realThink, 'agnes-3.0-flash'));
  // 旧行为：thinking 会比 fast 多约 20% 积分。这里断言不再多扣。
  check('thinking 不再比 fast 多扣（旧 ×1.2）',
    B.deductCredits(realThink, 'agnes-3.0-flash') === B.deductCredits(realFast, 'agnes-3.0-flash'));
  check('未知模型不扣费', B.deductCredits(real, 'no-such-model') === 0);
  check('零 token 不扣费', B.deductCredits(B.calculateBilling(0, 0, 'thinking', 8192), 'agnes-3.0-flash') === 0);
}

// ==================== 6. 回归护栏：造假符号不得回归 ====================
console.log('\n=== 6. 回归护栏（删除的符号不得回归） ===');
{
  const removed = [
    'MODE_MULTIPLIER', 'MAX_ALLOWED_MULTIPLIER', 'multiplierFor',
    'deterministicRound', 'applyAntiReverseRounding',
  ];
  const ns = B as unknown as Record<string, unknown>;
  for (const sym of removed) {
    check(`${sym} 已不再导出（防止造假机制悄悄回归）`, !(sym in ns), `仍导出 ${sym}`);
  }
  for (const sym of ['normalizeMode', 'calculateBilling', 'deductCredits']) {
    check(`${sym} 仍导出（兼容既有调用点）`, sym in ns);
  }
}

console.log(`\nToken Billing 单轨测试：${pass} 通过 / ${fail} 失败`);
if (fail === 0) {
  console.log('\n[UNVERIFIED] 未在本机验证：真实 provider usage 的端到端扣费一致性');
  console.log('  （需要可用的 Postgres 与一次真实的 chat 请求）');
}
setTimeout(() => process.exit(fail > 0 ? 1 : 0), 120);
