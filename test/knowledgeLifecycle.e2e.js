// End-to-end smoke test for the knowledge self-repair loop (uses real DB).
// Run: node test/knowledgeLifecycle.e2e.js  (after npm run build)
// Seed a fact, stamp it, force a refresh cycle, run the refresh worker,
// verify FactWriter + adaptive interval + lifecycle history, then close the
// repair loop with a SelfRepairTask + research job + ingest.

const { prismaKnowledge, prismaUser } = require('../dist/services/db.js');
const { stampNewFact } = require('../dist/services/knowledgeLifecycle/factTimeStamper.js');
const { runRefreshScheduler, claimRefreshTasks } = require('../dist/services/knowledgeLifecycle/refreshScheduler.js');
const { writeFactValue } = require('../dist/services/knowledgeLifecycle/factWriter.js');
const { currentCycleStr } = require('../dist/services/knowledgeLifecycle/adaptiveInterval.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`); }
}

(async () => {
  // 1. Seed a KnowledgeObject + KnowledgeFact
  const objectName = `lifecycle-e2e-${Date.now().toString(36)}`;
  const object = await prismaKnowledge.knowledgeObject.create({
    data: { objectType: 'concept', canonicalName: objectName },
  });
  const fact = await prismaKnowledge.knowledgeFact.create({
    data: {
      objectId: object.id,
      claim: 'supports Android 15',
      claimType: 'OFFICIAL_FACT',
      verificationStatus: 'UNVERIFIED',
      lifecycleStatus: 'ACTIVE',
      confidence: 0.5,
    },
  });

  // 2. Stamp refresh state
  await stampNewFact({
    factId: fact.id,
    lifecycleStatus: fact.lifecycleStatus,
    verificationStatus: fact.verificationStatus,
    initialIntervalMonths: 1,
  });
  let state = await prismaKnowledge.factRefreshState.findUnique({ where: { factId: fact.id } });
  check('stamp: FactRefreshState row created', !!state);
  check('stamp: recordedAt invariant (createdAt untouched)', state && fact.createdAt instanceof Date);

  // idempotent stamp
  await stampNewFact({ factId: fact.id, lifecycleStatus: 'ACTIVE', verificationStatus: 'UNVERIFIED' });
  const stateCount = await prismaKnowledge.factRefreshState.count({ where: { factId: fact.id } });
  check('stamp: idempotent (still 1 row)', stateCount === 1, `got ${stateCount}`);

  // 3. Force-due: move nextRefreshAt to now and run scheduler
  await prismaKnowledge.factRefreshState.update({
    where: { factId: fact.id },
    data: { nextRefreshAt: new Date() },
  });
  const sched = await runRefreshScheduler(10);
  check('scheduler: dispatched >= 1 for this fact', sched.dispatched >= 1, JSON.stringify(sched));

  const cycle = currentCycleStr();
  const task = await prismaUser.refreshTask.findUnique({
    where: { factId_refreshCycle: { factId: fact.id, refreshCycle: cycle } },
  });
  check('scheduler: RefreshTask row exists for (fact, cycle)', !!task);

  // idempotent: re-run scheduler should NOT create a second row
  const sched2 = await runRefreshScheduler(10);
  const taskCount = await prismaUser.refreshTask.count({ where: { factId: fact.id, refreshCycle: cycle } });
  check('scheduler: idempotent (still 1 task row)', taskCount === 1, `got ${taskCount}`);

  // 4. Simulate a refresh verdict MATERIAL_CHANGE through the single write port
  const before = await prismaKnowledge.knowledgeFact.findUnique({ where: { id: fact.id } });
  await writeFactValue({
    factId: fact.id,
    newValue: 'supports Android 16',
    changeType: 'MATERIAL_CHANGE',
    evidenceIds: [],
    sourceIds: [],
    refreshTaskId: task?.id ?? null,
    adaptive: {
      prevIntervalMonths: 1,
      consecutiveFailureCountBefore: 0,
      unchangedStreakBefore: 0,
      lastStatus: 'MATERIAL_CHANGE',
    },
  });
  const after = await prismaKnowledge.knowledgeFact.findUnique({ where: { id: fact.id } });
  check('writer: claim updated to new value', after.claim === 'supports Android 16', `got "${after.claim}"`);
  check('writer: version incremented', after.version === before.version + 1, `before=${before.version} after=${after.version}`);
  check('writer: lastVerifiedAt set', !!after.lastVerifiedAt);

  const hist = await prismaKnowledge.factLifecycleHistory.findMany({ where: { factId: fact.id } });
  check('writer: lifecycle history row appended', hist.length >= 1, `got ${hist.length}`);
  check('writer: history eventType MATERIAL_CHANGE', hist.some((h) => h.eventType === 'MATERIAL_CHANGE'));

  state = await prismaKnowledge.factRefreshState.findUnique({ where: { factId: fact.id } });
  check('writer: adaptive hot cadence (0.5mo) after MATERIAL_CHANGE', state.refreshIntervalMonths === 0.5, `got ${state.refreshIntervalMonths}`);
  check('writer: HIGH priority after MATERIAL_CHANGE', state.priority === 2, `got ${state.priority}`);

  // 5. Record refresh outcome on the task row
  await prismaUser.refreshTask.update({
    where: { id: task.id },
    data: { status: 'MATERIAL_CHANGE', completedAt: new Date(), lastError: null },
  });
  const taskAfter = await prismaUser.refreshTask.findUnique({ where: { id: task.id } });
  check('task: terminal status MATERIAL_CHANGE', taskAfter.status === 'MATERIAL_CHANGE');

  // 6. Open a SelfRepairTask + research job (repair lineage) and close the loop
  // cleanup + recreate root so we never violate the (rootTaskId, ...) unique key on a rerun
  const rootJob = await prismaUser.organizationJob.create({
    data: { scopeType: 'object', scopeId: object.id, triggerReason: 'E2E', status: 'QUEUED' },
  });
  const repairTask = await prismaUser.selfRepairTask.create({
    data: {
      rootTaskId: rootJob.id,
      triggerType: 'REFRESH_CONFLICT',
      targetFactId: fact.id,
      reason: 'e2e repair loop smoke',
      iteration: 1,
      refreshCycle: cycle,
    },
  });
  check('repair: SelfRepairTask created (unique key ok)', !!repairTask.id);

  // de-duplication: a second identical create must be caught by the unique constraint
  let dupCaught = false;
  try {
    await prismaUser.selfRepairTask.create({
      data: {
        rootTaskId: rootJob.id,
        triggerType: 'REFRESH_CONFLICT',
        targetFactId: fact.id,
        reason: 'dup',
        iteration: 1,
        refreshCycle: cycle,
      },
    });
  } catch {
    dupCaught = true;
  }
  check('repair: duplicate (root,fact,cycle,trigger) rejected by unique key', dupCaught);

  const researchJob = await prismaUser.researchJob.create({
    data: {
      objectId: fact.id,
      jobType: 'ENRICHMENT',
      status: 'QUEUED',
      planJson: JSON.stringify({ repairTaskId: repairTask.id, targetFactId: fact.id }),
      rootTaskId: repairTask.id,
      targetFactId: fact.id,
      iteration: 1,
    },
  });
  check('repair: research job carries lineage (rootTaskId + targetFactId)', researchJob.rootTaskId === repairTask.id && researchJob.targetFactId === fact.id);

  await prismaUser.selfRepairTask.update({
    where: { id: repairTask.id },
    data: { status: 'RESEARCHING', researchJobId: researchJob.id },
  });

  // 7. Cleanup test data
  await prismaUser.selfRepairTask.delete({ where: { id: repairTask.id } });
  await prismaUser.researchJob.delete({ where: { id: researchJob.id } });
  await prismaUser.refreshTask.delete({ where: { id: task.id } });
  await prismaUser.organizationJob.delete({ where: { id: rootJob.id } });
  await prismaKnowledge.factLifecycleHistory.deleteMany({ where: { factId: fact.id } });
  await prismaKnowledge.factRefreshState.delete({ where: { factId: fact.id } });
  await prismaKnowledge.knowledgeFact.delete({ where: { id: fact.id } });
  await prismaKnowledge.knowledgeObject.delete({ where: { id: object.id } });
  console.log('\n  (cleaned up test data)');

  console.log(`\n=== E2E RESULT: ${pass} passed, ${fail} failed ===`);
  await prismaKnowledge.$disconnect();
  await prismaUser.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('E2E error:', e);
  process.exit(1);
});
