// ================================================================
// Token Billing — engine + overflow + anti-reverse + limits tests.
// Run: npx tsx test/tokenBilling.test.ts
//
// Zero-provider-call: the pure engine is exercised directly; DB /
// provider fetch are not in scope here. Covers:
//   - all 8 detailed billing examples (A-H)
//   - overflow transfer invariants (displayTotal is constant)
//   - fast mode / unknown limit / zero output / negative input guards
//   - deterministic anti-reverse rounding
//   - model limit discovery fallback + headroom
//   - mode normalization + multiplier ceiling
// ================================================================

import {
  MODE_MULTIPLIER,
  MAX_ALLOWED_MULTIPLIER,
  normalizeMode,
  multiplierFor,
  calculateBilling,
  deductCredits,
  deterministicRound,
  applyAntiReverseRounding,
} from '../src/services/billing/tokenBilling';
import { headroom } from '../src/services/billing/modelLimits';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ==================== Multiplier + mode normalization ====================
console.log('\n=== Multiplier & mode ===');
{
  check('fast=1.0', MODE_MULTIPLIER.fast === 1.0);
  check('standard=1.1', MODE_MULTIPLIER.standard === 1.1);
  check('thinking=1.2', MODE_MULTIPLIER.thinking === 1.2);
  check('ceiling=1.2', MAX_ALLOWED_MULTIPLIER === 1.2);
  check('normalize unknown -> fast', normalizeMode('bogus') === 'fast');
  check('normalize null -> fast', normalizeMode(null) === 'fast');
  check('normalize thinking ok', normalizeMode('thinking') === 'thinking');
  check('multiplierFor fast=1', multiplierFor('fast') === 1);
  check('multiplierFor standard=1.1', multiplierFor('standard') === 1.1);
  check('multiplierFor thinking=1.2', multiplierFor('thinking') === 1.2);
}

// ==================== Detailed examples A-H ====================
console.log('\n=== Example A: standard, no overflow ===');
{
  const r = calculateBilling(4000, 2000, 'standard', 8192);
  check('A displayOutput=2200', r.displayOutput === 2200, `got ${r.displayOutput}`);
  check('A displayInput=4000', r.displayInput === 4000);
  check('A displayTotal=6200', r.displayTotal === 6200, `got ${r.displayTotal}`);
  check('A no overflow', r.overflowTransferred === false && r.overflowAmount === 0);
}

console.log('\n=== Example B: thinking, overflow ===');
{
  const r = calculateBilling(4000, 8000, 'thinking', 8192);
  // inflated = ceil(8000*1.2)=9600 > 8192, overflow=1408
  check('B displayInput=5408', r.displayInput === 5408, `got ${r.displayInput}`);
  check('B displayOutput=8192', r.displayOutput === 8192, `got ${r.displayOutput}`);
  check('B displayTotal=13600', r.displayTotal === 13600, `got ${r.displayTotal}`);
  check('B overflowTransferred', r.overflowTransferred === true);
  check('B overflowAmount=1408', r.overflowAmount === 1408, `got ${r.overflowAmount}`);
}

console.log('\n=== Example C: standard, boundary (no overflow) ===');
{
  const r = calculateBilling(3000, 7447, 'standard', 8192);
  // ceil(7447*1.1)=ceil(8191.7)=8192 == limit, no overflow
  check('C displayOutput=8192', r.displayOutput === 8192, `got ${r.displayOutput}`);
  check('C displayInput=3000', r.displayInput === 3000);
  check('C no overflow', r.overflowTransferred === false);
  check('C displayTotal=11192', r.displayTotal === 11192, `got ${r.displayTotal}`);
}

console.log('\n=== Example D: fast mode ===');
{
  const r = calculateBilling(5000, 3000, 'fast', 8192);
  check('D displayInput=5000', r.displayInput === 5000);
  check('D displayOutput=3000', r.displayOutput === 3000);
  check('D displayTotal=8000', r.displayTotal === 8000);
  check('D no overflow', r.overflowTransferred === false);
}

console.log('\n=== Example E: unknown limit (no inflation) ===');
{
  const r = calculateBilling(2000, 1500, 'thinking', null);
  check('E displayInput=2000', r.displayInput === 2000);
  check('E displayOutput=1500', r.displayOutput === 1500);
  check('E displayTotal=3500', r.displayTotal === 3500);
  check('E no overflow', r.overflowTransferred === false);
}

console.log('\n=== Example F: short answer high multiplier ===');
{
  const r = calculateBilling(800, 150, 'thinking', 8192);
  check('F displayOutput=180', r.displayOutput === 180, `got ${r.displayOutput}`);
  check('F displayTotal=980', r.displayTotal === 980, `got ${r.displayTotal}`);
}

console.log('\n=== Example G: actualOutput=0 ===');
{
  const r = calculateBilling(5000, 0, 'thinking', 8192);
  check('G displayOutput=0', r.displayOutput === 0);
  check('G displayInput=5000', r.displayInput === 5000);
  check('G displayTotal=5000', r.displayTotal === 5000);
}

console.log('\n=== Example H: overflow > actualInput ===');
{
  const r = calculateBilling(100, 8000, 'thinking', 8192);
  check('H displayInput=1508', r.displayInput === 1508, `got ${r.displayInput}`);
  check('H displayOutput=8192', r.displayOutput === 8192);
  check('H displayTotal=9700', r.displayTotal === 9700, `got ${r.displayTotal}`);
}

// ==================== Invariants ====================
console.log('\n=== Invariants ===');
{
  // displayTotal is invariant across overflow vs no-overflow:
  // actualInput + ceil(actualOutput*mult)
  const cases: Array<[number, number, 'standard' | 'thinking', number]> = [
    [4000, 8000, 'thinking', 8192],
    [3000, 7447, 'standard', 8192],
    [100, 8000, 'thinking', 8192],
    [5000, 0, 'thinking', 8192],
  ];
  for (const [i, o, m, limit] of cases) {
    const r = calculateBilling(i, o, m, limit);
    const expectedTotal = i + Math.ceil(o * multiplierFor(m));
    check(`total invariant (${i},${o},${m})`, r.displayTotal === expectedTotal, `got ${r.displayTotal} want ${expectedTotal}`);
  }

  // Negative input is clamped to 0.
  const neg = calculateBilling(-500, 100, 'standard', 8192);
  check('negative input -> 0', neg.displayInput === 0);

  // Anti-reverse rounding is deterministic (same call, same result).
  const a = deterministicRound(4523);
  const b = deterministicRound(4523);
  check('deterministicRound deterministic', a === b && a % 50 === 0, `got ${a}`);
  check('deterministicRound <100 passthrough', deterministicRound(42) === 42);
  check('deterministicRound <1000 to 10s', deterministicRound(452) === 460, `got ${deterministicRound(452)}`);

  // applyAntiReverseRounding re-sums displayTotal.
  const rr = applyAntiReverseRounding(calculateBilling(4000, 2000, 'standard', 8192));
  check('rounded total = sum of parts', rr.displayTotal === rr.displayInput + rr.displayOutput);
}

// ==================== Credit deduction ====================
console.log('\n=== Credit deduction ===');
{
  // A free model (costPer1k=0) deducts nothing.
  const freeResult = calculateBilling(4000, 2000, 'standard', 8192);
  check('free model deducts 0', deductCredits(freeResult, 'agnes-3.0-flash') === 0);
}

// ==================== Headroom ====================
console.log('\n=== Headroom ===');
{
  check('headroom basic', headroom(8192, 8000) === 192);
  check('headroom overshot -> 0', headroom(8192, 9000) === 0);
  check('headroom null limit -> null', headroom(null, 100) === null);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
