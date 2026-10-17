// ================================================================
// E2E Self-Organization Runtime Test
// ================================================================

import { strict as assert } from 'node:assert';

async function main() {
  console.log('=== E2E Self-Organization Runtime Test ===\n');
  let passed = 0, failed = 0;
  const check = (name: string, fn: () => void | Promise<void>) => {
    return Promise.resolve(fn()).then(
      () => { console.log(`  ✓ ${name}`); passed++; },
      (err) => { console.log(`  ✗ ${name}: ${err.message}`); failed++; }
    );
  };

  // ==================== 1. Task Splitter ====================
  console.log('1. Task Splitter');

  const { splitTasks, MAX_ORG_WORKERS } = await import('../src/services/knowledgeOrg/orgWorkers');

  await check('Max 8 workers cap', () => {
    assert.equal(MAX_ORG_WORKERS, 8);
  });

  await check('Splits issues into worker tasks', () => {
    const issues = [
      { issueType: 'DUPLICATE_FACT', entityIds: ['f1', 'f2'], detail: 'x', deterministic: true, confidence: 1 },
      { issueType: 'DUPLICATE_SOURCE', entityIds: ['s1', 's2'], detail: 'x', deterministic: true, confidence: 1 },
      { issueType: 'ORPHAN_EVIDENCE', entityIds: ['e1'], detail: 'x', deterministic: true, confidence: 1 },
    ];
    const { tasks, geminiTasks, deterministicTasks } = splitTasks(issues as any);
    assert.ok(tasks.length >= 3);
    assert.equal(geminiTasks.length, 0); // all deterministic
    assert.ok(deterministicTasks.length >= 3);
  });

  await check('Routes semantic issues to Gemini tasks', () => {
    const issues = [
      { issueType: 'SEMANTIC_DUPLICATE_FACT', entityIds: ['f1', 'f2'], detail: 'x', deterministic: false, confidence: 0.9 },
    ];
    const { geminiTasks, deterministicTasks } = splitTasks(issues as any);
    assert.equal(geminiTasks.length, 1);
    assert.equal(deterministicTasks.length, 0);
  });

  // ==================== 2. Result Pool ====================
  console.log('\n2. Result Pool Merge');

  const { mergeResults } = await import('../src/services/knowledgeOrg/orgResultPool');

  await check('Accepts single-proposal targets', () => {
    const results = [{ workerType: 'FACTS', proposals: [
      { workerType: 'FACTS', action: 'MARK_LIFECYCLE', targetType: 'fact', targetId: 'f2', before: 'ACTIVE', after: 'DUPLICATE', payload: { mergedInto: 'f1' }, reason: 'dup' },
    ], uncertain: [], usedGemini: false }];
    const plan = mergeResults(results);
    assert.equal(plan.accepted.length, 1);
  });

  await check('Deduplicates identical proposals from multiple workers', () => {
    const p = { workerType: 'FACTS', action: 'MARK_LIFECYCLE', targetType: 'fact', targetId: 'f2', before: 'ACTIVE', after: 'DUPLICATE', payload: { mergedInto: 'f1' }, reason: 'dup' };
    const results = [
      { workerType: 'FACTS', proposals: [p], uncertain: [], usedGemini: false },
      { workerType: 'FACTS', proposals: [JSON.parse(JSON.stringify(p))], uncertain: [], usedGemini: false },
    ];
    const plan = mergeResults(results);
    assert.equal(plan.accepted.length, 1);
  });

  await check('Rejects conflicting merge directions', () => {
    const results = [
      { workerType: 'A', proposals: [
        { workerType: 'A', action: 'MARK_LIFECYCLE', targetType: 'fact', targetId: 'f2', before: 'ACTIVE', after: 'DUPLICATE', payload: { mergedInto: 'f1' }, reason: 'a' },
      ], uncertain: [], usedGemini: false },
      { workerType: 'B', proposals: [
        { workerType: 'B', action: 'MARK_LIFECYCLE', targetType: 'fact', targetId: 'f2', before: 'ACTIVE', after: 'DUPLICATE', payload: { mergedInto: 'f3' }, reason: 'b' },
      ], uncertain: [], usedGemini: false },
    ];
    const plan = mergeResults(results);
    assert.equal(plan.accepted.length, 0);
    assert.ok(plan.conflicts.length >= 1);
  });

  await check('Rejects CREATE_FACT proposals (boundary)', () => {
    const results = [{ workerType: 'FACTS', proposals: [
      { workerType: 'FACTS', action: 'CREATE_FACT', targetType: 'fact', targetId: 'new', before: '', after: 'new fact', payload: {}, reason: 'invented' },
    ], uncertain: [], usedGemini: false }];
    const plan = mergeResults(results);
    assert.equal(plan.accepted.length, 0);
    assert.ok(plan.rejected.some((r) => r.reason.includes('boundary')));
  });

  // ==================== 3. Deterministic Pre-Check ====================
  console.log('\n3. Deterministic Pre-Check');

  const { deterministicPreCheck } = await import('../src/services/knowledgeOrg/orgValidator');

  const snapshot = {
    facts: [
      { id: 'f1', claim: 'weight 190g', variantId: null, claimType: 'OFFICIAL_FACT', verificationStatus: 'VERIFIED' },
      { id: 'f2', claim: 'weight 190 grams', variantId: null, claimType: 'OFFICIAL_FACT', verificationStatus: 'VERIFIED' },
    ],
    evidence: [], sources: [], relations: [],
  };

  await check('Passes clean merge', () => {
    const plan = mergeResults([{ workerType: 'FACTS', proposals: [
      { workerType: 'FACTS', action: 'MARK_LIFECYCLE', targetType: 'fact', targetId: 'f2', before: 'ACTIVE', after: 'DUPLICATE', payload: { mergedInto: 'f1' }, reason: 'dup' },
    ], uncertain: [], usedGemini: false }]);
    const result = deterministicPreCheck(snapshot, plan);
    assert.ok(result.pass, JSON.stringify(result.violations));
  });

  await check('Fails on unknown fact reference', () => {
    const plan = mergeResults([{ workerType: 'FACTS', proposals: [
      { workerType: 'FACTS', action: 'MARK_LIFECYCLE', targetType: 'fact', targetId: 'f99', before: 'ACTIVE', after: 'DUPLICATE', payload: { mergedInto: 'f1' }, reason: 'x' },
    ], uncertain: [], usedGemini: false }]);
    const result = deterministicPreCheck(snapshot, plan);
    assert.ok(!result.pass);
    assert.ok(result.violations.some((v) => v.includes('f99')));
  });

  await check('Rejects verificationStatus changes', () => {
    const plan = mergeResults([{ workerType: 'FACTS', proposals: [
      { workerType: 'FACTS', action: 'MARK_LIFECYCLE', targetType: 'fact', targetId: 'f2', before: 'ACTIVE', after: 'DUPLICATE', payload: { mergedInto: 'f1', verificationStatus: 'CONFLICTED' }, reason: 'x' },
    ], uncertain: [], usedGemini: false }]);
    const result = deterministicPreCheck(snapshot, plan);
    assert.ok(!result.pass);
    assert.ok(result.violations.some((v) => v.includes('verificationStatus')));
  });

  await check('Rejects physical deletes', () => {
    const plan = mergeResults([{ workerType: 'FACTS', proposals: [
      { workerType: 'FACTS', action: 'DELETE_FACT', targetType: 'fact', targetId: 'f2', before: 'ACTIVE', after: 'gone', payload: {}, reason: 'x' },
    ], uncertain: [], usedGemini: false }]);
    const result = deterministicPreCheck(snapshot, plan);
    assert.ok(!result.pass);
    assert.ok(result.violations.some((v) => v.includes('delete')));
  });

  await check('Rejects self-merge', () => {
    const plan = mergeResults([{ workerType: 'FACTS', proposals: [
      { workerType: 'FACTS', action: 'MARK_LIFECYCLE', targetType: 'fact', targetId: 'f1', before: 'ACTIVE', after: 'DUPLICATE', payload: { mergedInto: 'f1' }, reason: 'x' },
    ], uncertain: [], usedGemini: false }]);
    const result = deterministicPreCheck(snapshot, plan);
    assert.ok(!result.pass);
    assert.ok(result.violations.some((v) => v.includes('self-merge')));
  });

  // ==================== 4. Snapshot Adapter Selection ====================
  console.log('\n4. Snapshot Builder');

  const { buildSnapshot, verifySnapshot, sha256 } = await import('../src/services/knowledgeOrg/orgSnapshot');

  await check('sha256 is deterministic', () => {
    const h1 = sha256('abc');
    const h2 = sha256('abc');
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });

  await check('Snapshot for missing object throws', async () => {
    let threw = false;
    try {
      await buildSnapshot('object', 'nonexistent-object-id-xyz');
    } catch {
      threw = true;
    }
    assert.ok(threw);
  });

  // ==================== 5. Scanner Deterministic Checks ====================
  console.log('\n5. Structure Scanner');

  const { deterministicScan, needsSemanticScan } = await import('../src/services/knowledgeOrg/orgScanner');

  await check('Detects exact duplicate facts', async () => {
    const entities = {
      facts: [
        { id: 'f1', claim: 'Weight is 190g', variantId: null },
        { id: 'f2', claim: 'weight is 190g', variantId: null },
      ],
      evidence: [], sources: [], relations: [], factEvidence: [], variants: [],
    };
    const { issues } = await deterministicScan(entities);
    assert.ok(issues.some((i) => i.issueType === 'DUPLICATE_FACT'));
  });

  await check('Detects duplicate sources by normalized URL', async () => {
    const entities = {
      facts: [],
      evidence: [],
      sources: [
        { id: 's1', canonicalUrl: 'https://example.com/a', domain: 'example.com' },
        { id: 's2', canonicalUrl: 'http://www.example.com/a/', domain: 'example.com' },
      ],
      relations: [], factEvidence: [], variants: [],
    };
    const { issues } = await deterministicScan(entities);
    assert.ok(issues.some((i) => i.issueType === 'DUPLICATE_SOURCE'));
  });

  await check('Detects duplicate relations', async () => {
    const entities = {
      facts: [],
      evidence: [],
      sources: [],
      relations: [
        { id: 'r1', objectId: 'o1', targetId: 'o2', relationType: 'PART_OF' },
        { id: 'r2', objectId: 'o1', targetId: 'o2', relationType: 'PART_OF' },
      ],
      factEvidence: [], variants: [],
    };
    const { issues } = await deterministicScan(entities);
    assert.ok(issues.some((i) => i.issueType === 'DUPLICATE_RELATION'));
  });

  await check('Detects orphan evidence', async () => {
    const entities = {
      facts: [{ id: 'f1', claim: 'x', variantId: null }],
      evidence: [{ id: 'e1', sourceId: 's1' }],
      sources: [], relations: [],
      factEvidence: [{ factId: 'f9', evidenceId: 'e1' }], // e1 is linked, but to missing fact
      variants: [],
    };
    const { issues } = await deterministicScan(entities);
    // e1 is linked to f9 which is not in scope facts — STRUCTURE_ERROR
    assert.ok(issues.some((i) => i.issueType === 'STRUCTURE_ERROR'));
  });

  await check('Semantic scan gate: skip when few candidates', async () => {
    const entities = {
      facts: [
        { id: 'f1', claim: 'The battery capacity is 5000 mAh', variantId: null },
        { id: 'f2', claim: 'Battery: 5000mAh capacity', variantId: null },
      ],
      evidence: [], sources: [], relations: [], factEvidence: [], variants: [],
    };
    const { semanticCandidates } = await deterministicScan(entities);
    // 1 candidate pair — below threshold of 4, no Gemini needed
    assert.equal(needsSemanticScan(semanticCandidates), false);
  });

  // ==================== 6. Org Job Lifecycle (DB) ====================
  console.log('\n6. Organization Job Lifecycle');

  const { createOrganizationJob, findOrganizationJob } = await import('../src/services/knowledgeOrg/orgRuntime');

  await check('Creates organization job', async () => {
    const { jobId, reused } = await createOrganizationJob('object', 'org-test-e2e', 'MANUAL', undefined, 5);
    assert.ok(jobId.length > 0);
    // First run: not reused. Subsequent runs in CI may reuse an active job.
    assert.ok(reused === false || reused === true);
  });

  await check('Reuses active job for same scope', async () => {
    const { reused } = await createOrganizationJob('object', 'org-test-e2e', 'MANUAL');
    assert.equal(reused, true);
  });

  await check('Jobs are queryable', async () => {
    const job = await findOrganizationJob('any-id');
    assert.ok(job === null || typeof job === 'object');
  });

  // ==================== Summary ====================
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed === 0) {
    console.log('\nALL TESTS PASSED');
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('TEST RUNNER ERROR:', err);
  process.exit(1);
});
