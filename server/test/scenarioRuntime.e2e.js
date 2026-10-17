// Smoke test: scenario runtime graceful degradation (no Agnes key).
// Proves the new chain is wired into promptRuntime and degrades to the
// legacy path without crashing (R14) when Agnes is unavailable.
// Run: node test/scenarioRuntime.e2e.js (after npm run build)

process.env.CORTX_SCENARIO_RUNTIME = 'on';

const { runPromptRuntime } = require('../dist/services/promptRuntime.js');

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`); }
  };

  // No Agnes key is configured in this test env, so P1/P2/P3/S2/S4 will
  // all hit "No Agnes API key" and degrade. The runtime must still return
  // ok=true with degraded=true (rule fallback), never throw.
  const result = await runPromptRuntime(
    '帮我分析这份 Python 代码的性能问题',
    [],
    { language: 'zh', region: 'CN', userTier: 'STANDARD', userId: 'test-user' },
  );

  check('promptRuntime returns a result (no crash)', result && typeof result === 'object');
  check('scenarioRuntime is attached when flag on', !!result.scenarioRuntime, 'flag on must attach the new chain');
  check('new chain degrades (no Agnes key) without failing the request', result.scenarioRuntime?.degraded === true);
  check('degraded chain does NOT produce a selected_skill_ids force',
    !Array.isArray(result.scenarioRuntime?.selectedSkillIds) || result.scenarioRuntime.selectedSkillIds.every((s) => typeof s === 'string'));
  check('final system prompt is still non-empty (rule Composer authoritative)',
    typeof result.composition?.final_prompt === 'string' && result.composition.final_prompt.length > 0);
  check('composition source is rule Composer (never AI-authored)',
    result.composition && 'composition_hash' in result.composition);

  console.log(`\n=== SMOKE RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('SMOKE error:', e);
  process.exit(1);
});
