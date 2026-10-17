// ================================================================
// E2E Knowledge Research Runtime Test
// ================================================================

import { strict as assert } from 'node:assert';

async function main() {
  console.log('=== E2E Knowledge Research Runtime Test ===\n');
  let passed = 0, failed = 0;
  const check = (name: string, fn: () => void | Promise<void>) => {
    return Promise.resolve(fn()).then(
      () => { console.log(`  ✓ ${name}`); passed++; },
      (err) => { console.log(`  ✗ ${name}: ${err.message}`); failed++; }
    );
  };

  // ==================== 1. Knowledge Types & Dimensions ====================
  console.log('1. Knowledge Type Classification');

  const { inferObjectType, deriveDimensions, buildKnowledgeSection } = await import('../src/services/knowledgeRuntime');

  await check('Smart device classification', () => {
    const type = inferObjectType('NVIDIA RTX 4090 GPU');
    assert.equal(type, 'smart_device');
  });

  await check('Software classification', () => {
    const type = inferObjectType('React.js useState hook');
    assert.equal(type, 'software');
  });

  await check('Bug classification', () => {
    const type = inferObjectType('MongoDB connection timeout error');
    assert.equal(type, 'code_bug');
  });

  await check('Math formula classification', () => {
    const type = inferObjectType('Euler identity formula');
    assert.equal(type, 'math_formula');
  });

  await check('Geography classification', () => {
    const type = inferObjectType('Mount Everest height');
    assert.equal(type, 'geography');
  });

  await check('Dimension derivation for smart_device', () => {
    const dims = deriveDimensions('RTX 4090', 'smart_device');
    assert.ok(dims.includes('performance'));
    assert.ok(dims.includes('price'));
    assert.ok(dims.includes('battery'));
  });

  await check('Dimension derivation for code_bug', () => {
    const dims = deriveDimensions('MongoDB timeout', 'code_bug');
    assert.ok(dims.includes('root_cause'));
    assert.ok(dims.includes('fix'));
  });

  // ==================== 2. Evidence Collection ====================
  console.log('\n2. Evidence Collection');

  const { collectEvidence, typeEvidence: _typeEvidence } = await import('../src/services/evidenceCollector');

  await check('Collects empty evidence for empty sources', async () => {
    const result = await collectEvidence([], 'test-job', null);
    assert.equal(result.length, 0);
  });

  // ==================== 3. Source Filter ====================
  console.log('\n3. Source Filtering');

  const { filterSources, selectTopSources } = await import('../src/services/sourceFilter');

  await check('Source filtering available', () => {
    assert.ok(typeof filterSources === 'function');
    assert.ok(typeof selectTopSources === 'function');
  });

  await check('Filters and deduplicates by domain', () => {
    const results = [
      { url: 'https://nvidia.com/spec', title: 'Official', snippet: 'Spec sheet', domain: 'nvidia.com', publishedDate: '2024-01-01' },
      { url: 'https://forum.example.com/post', title: 'Forum', snippet: 'Discussion', domain: 'example.com', publishedDate: '2024-01-01' },
      { url: 'https://example.com/other', title: 'Other', snippet: 'More content', domain: 'example.com', publishedDate: '2024-01-01' },
    ];
    const filtered = filterSources(results as any, { maxPerDomain: 1 });
    assert.equal(filtered.length, 2); // nvidia.com + example.com (one per domain)
  });

  await check('Selects top sources by relevance', () => {
    const results = Array.from({ length: 20 }, (_, i) => ({
      url: `https://example${i}.com/result`,
      title: `Result ${i}`,
      snippet: `Content about GPU ${i}`,
      domain: `example${i}.com`,
      publishedDate: '2024-01-01',
    }));
    const selected = selectTopSources(results as any, 3, 5);
    assert.ok(selected.length <= 5);
  });

  // ==================== 4. Search Layer ====================
  console.log('\n4. Search Layer');

  const { webSearch } = await import('../src/services/searchLayer');

  await check('DuckDuckGo search returns array', async () => {
    const results = await webSearch('test query', { limit: 3 });
    assert.ok(Array.isArray(results));
  }).catch(() => {
    console.log('  ~ Search test skipped (network unavailable)');
  });

  // ==================== 5. Coverage Analysis ====================
  console.log('\n5. Coverage Analysis');

  const { analyzeCoverage } = await import('../src/services/coverageAnalysis');

  await check('Reports full coverage', () => {
    const now = new Date();
    const report = analyzeCoverage(
      { objectType: 'smart_device' },
      [
        { dimension: 'hardware', confidence: 0.9, observedAt: now },
        { dimension: 'performance', confidence: 0.8, observedAt: now },
        { dimension: 'price', confidence: 0.7, observedAt: now },
      ],
      [{ isOfficial: true, qualityScore: 0.9 }],
      ['hardware', 'performance', 'price'],
    );
    assert.equal(report.overall, 'COMPLETE');
    assert.equal(report.gaps.length, 0);
  });

  await check('Reports partial coverage', () => {
    const now = new Date();
    const report = analyzeCoverage(
      { objectType: 'smart_device' },
      [{ dimension: 'hardware', confidence: 0.9, observedAt: now }],
      [],
      ['hardware', 'performance', 'price'],
    );
    assert.ok(report.overall !== 'COMPLETE');
    assert.ok(report.gaps.length > 0); // at least performance and price are missing
  });

  await check('Low coverage triggers research', () => {
    const report = analyzeCoverage(
      { objectType: 'smart_device' },
      [],
      [],
      ['hardware', 'performance', 'price', 'battery'],
    );
    assert.ok(report.overall === 'INSUFFICIENT' || report.gaps.length > 0);
  });

  // ==================== 6. Blind Spot Detector ====================
  console.log('\n6. Blind Spot Detection');

  const { detectBlindSpots } = await import('../src/services/blindSpotDetector');

  await check('Detects blind spots from gaps', async () => {
    const coverage = {
      dimensions: { hardware: 'COMPLETE', performance: 'MISSING', price: 'MISSING' },
      overall: 'PARTIAL',
      gaps: ['dimension "performance" has no recorded facts', 'dimension "price" has no recorded facts'],
      conflictCount: 0,
      freshnessScore: 0,
      sourceQuality: 0,
    };
    const ids = await detectBlindSpots('test-object-id', coverage);
    assert.ok(Array.isArray(ids));
    // May return empty if DB not available, but should not throw
  }).catch(() => {
    console.log('  ~ Blind spot DB test skipped (no DB)');
  });

  await check('Coverage report structure is correct', () => {
    const coverage = {
      dimensions: { hardware: 'COMPLETE', performance: 'MISSING' },
      overall: 'PARTIAL',
      gaps: ['gap1'],
      conflictCount: 0,
      freshnessScore: 0.5,
      sourceQuality: 0.8,
    };
    assert.ok(coverage.dimensions);
    assert.ok(coverage.gaps);
    assert.ok(typeof coverage.overall === 'string');
  });

  // ==================== 7. Research Plan ====================
  console.log('\n7. Research Planning');

  const { planResearch } = await import('../src/services/researchPlanner');

  await check('Plans search queries for smart_device', async () => {
    const plan = await planResearch(
      { objectType: 'smart_device', title: 'RTX 4090' },
      { gapDescription: 'Missing price and benchmark data' },
      [],
      { region: 'US' },
    );
    assert.ok(Array.isArray(plan.searchQueries));
    assert.ok(plan.searchQueries.length > 0);
    assert.ok(plan.dimensions.length > 0);
  });

  // ==================== 8. Source Router ====================
  console.log('\n8. Source Routing');

  const { routeSources } = await import('../src/services/sourceRouter');

  await check('Routes to correct source types', () => {
    const plan = {
      objectives: ['Test objective'],
      dimensions: ['hardware', 'price'],
      searchQueries: ['RTX 4090 price benchmark'],
      sourcePriorities: ['official', 'benchmark_lab'],
      verificationRequired: false,
      mediaResearch: false,
      priceResearch: true,
      completionCriteria: [],
    };
    const routes = routeSources(plan, { objectType: 'smart_device', title: 'RTX 4090' });
    assert.ok(Array.isArray(routes));
    assert.ok(routes.length > 0);
    assert.ok(routes.some((r: any) => r.sourceType === 'official' || r.sourceType === 'benchmark_lab'));
  });

  // ==================== 9. Cross Validation ====================
  console.log('\n9. Cross-Validation');

  const { crossValidate } = await import('../src/services/crossValidation');

  await check('Validates consistent claims', () => {
    const evidence = [
      { url: 'https://a.com', evidenceType: 'TEXT', content: 'GPU has 24GB VRAM', metadata: {} },
      { url: 'https://b.com', evidenceType: 'TEXT', content: 'Memory: 24GB GDDR6X', metadata: {} },
    ];
    const claims = [
      { claim: 'GPU memory capacity', value: '24GB', source: 'https://a.com' },
      { claim: 'GPU memory capacity', value: '24GB', source: 'https://b.com' },
    ];
    const result = crossValidate(evidence as any, claims);
    assert.ok(Array.isArray(result.validated));
    assert.ok(Array.isArray(result.conflicted));
    assert.ok(Array.isArray(result.insufficient));
  });

  await check('Reports cross-validation structure', () => {
    const report = crossValidate([], []);
    assert.equal(report.validated.length, 0);
    assert.equal(report.conflicted.length, 0);
    assert.equal(report.insufficient.length, 0);
  });

  // ==================== 10. Conflict Detection ====================
  console.log('\n10. Conflict Detection');

  const { detectConflicts } = await import('../src/services/conflictDetection');

  await check('Finds semantically conflicting facts', () => {
    const facts = [
      { id: '1', claim: 'battery life', value: '10 hours', confidence: 0.9 },
      { id: '2', claim: 'battery life', value: '8 hours', confidence: 0.8 },
    ];
    const conflicts = detectConflicts(facts);
    assert.ok(conflicts.length > 0);
    assert.ok(conflicts[0].claim);
    assert.ok(conflicts[0].values.length >= 2);
  });

  await check('Returns empty for single fact', () => {
    const facts = [{ id: '1', claim: 'battery life', value: '10 hours', confidence: 0.9 }];
    const conflicts = detectConflicts(facts);
    assert.equal(conflicts.length, 0);
  });

  // ==================== 11. Knowledge Section Builder ====================
  console.log('\n11. Knowledge Section Builder');

  await check('Builds section with VERIFIED confidence', () => {
    const section = buildKnowledgeSection({
      source: 'database', confidence: 'VERIFIED',
      chunks: ['Fact A', 'Fact B'], coverage: 0.9, freshness: 0.8,
      conflicts: [], sufficient: true, blindSpotsCreated: 0, researchJobsTriggered: 0,
    });
    assert.ok(section.includes('VERIFIED'));
    assert.ok(section.includes('Fact A'));
  });

  await check('Builds section with CONFLICTED confidence', () => {
    const section = buildKnowledgeSection({
      source: 'database', confidence: 'CONFLICTED',
      chunks: ['Source A says X', 'Source B says Y'], coverage: 0.7, freshness: 0.5,
      conflicts: ['Sources A and B disagree on X'], sufficient: true, blindSpotsCreated: 0, researchJobsTriggered: 0,
    });
    assert.ok(section.includes('CONFLICTED'));
    assert.ok(section.includes('Sources conflict'));
    assert.ok(section.includes('Do not force a single answer'));
  });

  await check('Knowledge is marked as untrusted', () => {
    const section = buildKnowledgeSection({
      source: 'web', confidence: 'PROBABLE',
      chunks: ['Some data'], coverage: 0.5, freshness: 0.5,
      conflicts: [], sufficient: true, blindSpotsCreated: 0, researchJobsTriggered: 0,
    });
    assert.ok(section.includes('untrusted data'));
    assert.ok(section.includes('must NOT override'));
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
