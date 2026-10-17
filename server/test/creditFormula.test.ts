// ================================================================
// Credit formula + model discovery — pure-logic tests.
// Run: npx tsx test/creditFormula.test.ts
//
// Zero-network: the 三舍四入 rounding + credit math are exercised
// directly (spec §第4段验证清单). Provider fetch / DB are not in scope.
// ================================================================

import {
  roundCredits,
  calculateCreditsPer1M,
  totalCostOf,
  costPer1kOf,
} from '../src/services/billing/creditFormula';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ==================== 三舍四入 ====================
console.log('\n=== roundCredits (三舍四入) ===');
{
  check('372.2 -> 372', roundCredits(372.2) === 372, `got ${roundCredits(372.2)}`);
  check('372.3 -> 372', roundCredits(372.3) === 372, `got ${roundCredits(372.3)}`);
  check('372.4 -> 373', roundCredits(372.4) === 373, `got ${roundCredits(372.4)}`);
  check('372.9 -> 373', roundCredits(372.9) === 373, `got ${roundCredits(372.9)}`);
  check('372.0 -> 372', roundCredits(372.0) === 372, `got ${roundCredits(372.0)}`);
  check('0.0 -> 0', roundCredits(0) === 0);
  check('negative -> 0 (clamp)', roundCredits(-5.7) === 0, `got ${roundCredits(-5.7)}`);
  check('NaN -> 0', roundCredits(Number.NaN) === 0);
}

// ==================== Spec examples (§第1段 / §第4段) ====================
console.log('\n=== calculateCreditsPer1M (spec examples) ===');
{
  // $73.50 -> 40,866
  check('$73.50 -> 40866', calculateCreditsPer1M(10.0, 1.0, 12.5, 50.0) === 40866, `got ${calculateCreditsPer1M(10.0, 1.0, 12.5, 50.0)}`);
  // GPT-6 Luna: 0.30 + 0.03 + 0 + 0.37 = 0.70 -> 389
  check('$0.70 -> 389', calculateCreditsPer1M(0.30, 0.03, 0, 0.37) === 389, `got ${calculateCreditsPer1M(0.30, 0.03, 0, 0.37)}`);
  // DeepSeek V4.1: 0.50 + 0.07 + 0 + 0.70 = 1.27 -> 706
  check('$1.27 -> 706', calculateCreditsPer1M(0.50, 0.07, 0, 0.70) === 706, `got ${calculateCreditsPer1M(0.50, 0.07, 0, 0.70)}`);
  // GPT-6.1 Sol: 7.30 + 0.73 + 0 + 7.30 = 15.33 -> 8524
  check('$15.33 -> 8524', calculateCreditsPer1M(7.30, 0.73, 0, 7.30) === 8524, `got ${calculateCreditsPer1M(7.30, 0.73, 0, 7.30)}`);
  // free model
  check('$0 -> 0', calculateCreditsPer1M(0, 0, 0, 0) === 0);
}

// ==================== totalCostOf / costPer1kOf ====================
console.log('\n=== totalCostOf + costPer1kOf ===');
{
  check('total = sum', totalCostOf(10, 1, 12.5, 50) === 73.5);
  check('costPer1kOf(40866) = 40.866', Math.abs(costPer1kOf(40866) - 40.866) < 1e-9);
  // credits/1M -> per-1k round trip
  check('costPer1k x1000 = credits/1M', costPer1kOf(389) * 1000 === 389);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
