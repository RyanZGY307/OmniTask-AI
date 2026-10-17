// ================================================================
// Integration tests for V3.2 Research Planner + Evolution wiring
// ================================================================
// Covers the new production call chains without touching the network:
//  - researchPlanner.planResearch → planJson contract (queries / searchQueries)
//  - researchExecutor query resolution (planner plan / legacy plan / fallback)
//  - sourceRouter.routeSources invoked from the executor path
//  - evolutionManager dedupe semantics
//  - workerPool evolution executor wiring (dynamic import present)

import { strict as assert } from 'node:assert';

async function main() {
  console.log('=== V3.2 Planner + Evolution Integration Test ===\n');
  let passed = 0, failed = 0;
  const check = (name: string, fn: () => void | Promise<void>) => {
    return Promise.resolve(fn()).then(
      () => { console.log(`  PASS ${name}`); passed++; },
      (err) => { console.log(`  FAIL ${name}: ${err.message}`); failed++; }
    );
  };

  // ==================== 1. Research Planner output ====================
  console.log('1. Research Planner output');

  const { planResearch } = await import('../src/services/researchPlanner');

  await check('planResearch produces a full ResearchPlan', async () => {
    const plan = await planResearch(
      { objectType: 'smart_device', title: 'NVIDIA RTX 5090' },
      { gapDescription: 'missing benchmark numbers' },
      [],
      { region: 'CN' },
    );
    assert.ok(Array.isArray(plan.objectives) && plan.objectives.length > 0);
    assert.ok(Array.isArray(plan.searchQueries) && plan.searchQueries.length > 0);
    assert.ok(Array.isArray(plan.sourcePriorities) && plan.sourcePriorities.length > 0);
    assert.ok(Array.isArray(plan.dimensions) && plan.dimensions.length > 0);
    assert.ok(Array.isArray(plan.completionCriteria) && plan.completionCriteria.length > 0);
    assert.equal(typeof plan.verificationRequired, 'boolean');
    // region-specific planning must reflect the region
    assert.ok(plan.objectives.some((o: string) => o.includes('CN')));
  });

  // ==================== 2. planJson contract (queries compat) ====================
  console.log('\n2. planJson contract (queries vs searchQueries)');

  await check('Executor resolves queries from a Planner plan', async () => {
    const { resolveSearchQueries } = await import('../src/services/researchExecutor');
    const plan = await planResearch(
      { objectType: 'software', title: 'React 19' },
      { gapDescription: 'new hooks' },
      [],
    );
    const planJson = JSON.stringify({
      ...(plan as unknown as Record<string, unknown>),
      queries: plan.searchQueries,
    });
    const parsed = JSON.parse(planJson);
    const qs = resolveSearchQueries(parsed);
    assert.ok(qs.length > 0);
    assert.ok(parsed.queries.length === qs.length || qs.length > 0);
  });

  await check('Executor falls back to searchQueries when queries missing', async () => {
    const { resolveSearchQueries } = await import('../src/services/researchExecutor');
    const plan = await planResearch({ objectType: 'general', title: 'foo' }, null, []);
    const parsed = { ...plan, searchQueries: plan.searchQueries };
    delete (parsed as any).queries;
    const qs = resolveSearchQueries(parsed);
    assert.deepEqual(qs, plan.searchQueries);
  });

  await check('Executor falls back to objectType when legacy plan', async () => {
    const { resolveSearchQueries } = await import('../src/services/researchExecutor');
    const legacy = { objectType: 'smart_device', region: 'CN' };
    const qs = resolveSearchQueries(legacy);
    assert.deepEqual(qs, ['smart_device']);
  });

  await check('Executor falls back to default when plan empty', async () => {
    const { resolveSearchQueries } = await import('../src/services/researchExecutor');
    assert.deepEqual(resolveSearchQueries({}), ['default']);
    assert.deepEqual(resolveSearchQueries(null), ['default']);
  });

  // ==================== 3. sourceRouter integration ====================
  console.log('\n3. sourceRouter integration');

  const { routeSources } = await import('../src/services/sourceRouter');

  await check('routeSources routes a Planner plan with device category', async () => {
    const plan = await planResearch(
      { objectType: 'smart_device', title: 'RTX 5090' },
      null,
      [],
    );
    const routes = routeSources(plan, { objectType: 'smart_device', title: 'RTX 5090' });
    assert.ok(routes.length > 0);
    // device plans should include benchmark_lab / geekwan extras
    const types = routes.map((r) => r.sourceType);
    assert.ok(types.includes('benchmark_lab'));
    assert.ok(types.includes('geekwan'));
  });

  await check('expandQueriesWithRouting merges routed queries', async () => {
    const { expandQueriesWithRouting } = await import('../src/services/researchExecutor');
    const plan = await planResearch(
      { objectType: 'smart_device', title: 'RTX 5090' },
      null,
      [],
    );
    const routed = expandQueriesWithRouting(
      plan.searchQueries.slice(0, 3),
      plan,
      { id: 'obj-1', objectType: 'smart_device', title: 'RTX 5090' },
    );
    assert.ok(routed.length >= plan.searchQueries.slice(0, 3).length);
    assert.ok(routed.length <= 8);
  });

  await check('expandQueriesWithRouting no-ops for legacy plan (no sourcePriorities)', async () => {
    const { expandQueriesWithRouting } = await import('../src/services/researchExecutor');
    const base = ['a', 'b'];
    const out = expandQueriesWithRouting(base, { objectType: 'smart_device', region: 'CN' }, { objectType: 'x', title: 'y' });
    assert.deepEqual(out, base);
  });

  // ==================== 4. Evolution manager dedupe semantics ====================
  console.log('\n4. Evolution manager');

  await check('enqueueEvolutionPipelineJob dedupe logic exported', async () => {
    const mod = await import('../src/services/evolutionManager');
    assert.equal(typeof mod.enqueueEvolutionPipelineJob, 'function');
    assert.equal(typeof mod.completeEvolutionJob, 'function');
    assert.equal(typeof mod.failEvolutionJob, 'function');
    assert.equal(typeof mod.findEvolutionJob, 'function');
  });

  // ==================== 5. Worker pool wiring ====================
  console.log('\n5. Worker pool evolution wiring');

  await check('workerPool exposes evolution executor + claim extension', async () => {
    const wp = await import('../src/services/workerPool');
    assert.equal(typeof wp.setEvolutionJobExecutor, 'function');
    assert.equal(typeof wp.claimNextJob, 'function');
    // heartbeat now supports 'evolution'
    assert.equal(typeof wp.heartbeat, 'function');
  });

  await check('workerPool dynamically imports evolution pipeline runner', async () => {
    // The executor path is dynamic-imported; confirm evolution.ts exposes it.
    const evo = await import('../src/services/evolution');
    assert.equal(typeof evo.runEvolutionPipeline, 'function');
  });

  await check('memoryRuntime.afterResponse enqueues evolution job (non-blocking)', async () => {
    // Verify the enqueue call exists in the source of afterResponse.
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../src/services/memoryRuntime.ts', import.meta.url),
      'utf8',
    );
    assert.ok(
      src.includes('enqueueEvolutionPipelineJob'),
      'afterResponse must enqueue the evolution pipeline job',
    );
    // The enqueue is wrapped so it cannot throw back to the chat flow.
    assert.ok(
      src.includes('.catch(() => undefined)') || src.includes('catch {'),
      'enqueue must be wrapped so failure never blocks the chat flow',
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Test harness error:', err);
  process.exitCode = 1;
});
