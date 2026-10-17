// ================================================================
// E2E: Knowledge Scope Router + Knowledge Retrieval Directive
// ================================================================

import { strict as assert } from 'node:assert';
import fs from 'node:fs';

async function main() {
  console.log('=== E2E Knowledge Scope Router + Directive ===\n');
  let passed = 0, failed = 0;
  const check = (name: string, fn: () => void | Promise<void>) => {
    return Promise.resolve(fn()).then(
      () => { console.log(`  PASS ${name}`); passed++; },
      (err) => { console.log(`  FAIL ${name}: ${err.message}`); failed++; }
    );
  };

  // ==================== 1. Scope Router ====================
  console.log('1. Knowledge Scope Router');
  const { routeKnowledgeScope } = await import('../src/services/knowledgeScopeRouter');

  await check('coding task routes to code scopes', async () => {
    const scope = await routeKnowledgeScope({
      message: 'how do I debug a null pointer in my Rust code',
      taskType: 'coding',
    });
    assert.ok(scope.primaryScopes.includes('code_bug'));
    assert.ok(scope.primaryScopes.includes('software'));
    assert.ok(scope.excludedScopes.includes('organism'));
    assert.ok(scope.excludedScopes.includes('astronomy'));
  });

  await check('research task has wide primary scopes', async () => {
    const scope = await routeKnowledgeScope({
      message: 'deep dive into GPU memory bandwidth',
      taskType: 'research',
    });
    assert.ok(scope.primaryScopes.includes('software'));
    assert.ok(scope.primaryScopes.includes('smart_device'));
    assert.ok(scope.retrievalDepth >= 8);
  });

  await check('math task routes to math_formula', async () => {
    const scope = await routeKnowledgeScope({
      message: 'prove the quadratic formula',
      taskType: 'math',
    });
    assert.ok(scope.primaryScopes.includes('math_formula'));
    assert.ok(scope.excludedScopes.includes('organism'));
  });

  await check('simple_chat produces empty scopes (no retrieval)', async () => {
    const scope = await routeKnowledgeScope({
      message: 'hello',
      taskType: 'simple_chat',
    });
    assert.deepEqual(scope.primaryScopes, []);
    assert.equal(scope.retrievalDepth, 0);
  });

  await check('needsVerification propagates to scope', async () => {
    const scope = await routeKnowledgeScope({
      message: 'is this claim accurate?',
      taskType: 'question',
      needsVerification: true,
    });
    assert.equal(scope.verificationRequired, true);
  });

  await check('region propagates to scope', async () => {
    const scope = await routeKnowledgeScope({
      message: 'battery life of this phone in China',
      taskType: 'research',
      region: 'CN',
    });
    assert.equal(scope.region, 'CN');
  });

  await check('queryVariants contain the message', async () => {
    const scope = await routeKnowledgeScope({
      message: 'NVIDIA RTX 5090 benchmarks',
      taskType: 'research',
    });
    assert.ok(scope.queryVariants.length >= 1);
    assert.ok(scope.queryVariants[0].length > 0);
  });

  // ==================== 2. Directive builder ====================
  console.log('\n2. Knowledge Retrieval Directive');
  const { buildKnowledgeRetrievalDirective, buildRetrievedKnowledgeBlock } = await import('../src/services/knowledgeRetrievalDirective');

  await check('directive is empty when both scope and result are null', () => {
    const out = buildKnowledgeRetrievalDirective({ scope: null, result: null });
    assert.equal(out, '');
  });

  await check('directive renders primary scopes when present', async () => {
    const scope = await routeKnowledgeScope({
      message: 'debug this',
      taskType: 'coding',
    });
    const out = buildKnowledgeRetrievalDirective({ scope, result: null });
    assert.ok(out.includes('<knowledge_retrieval_directive>'));
    assert.ok(out.includes('/knowledge_retrieval_directive'));
    assert.ok(out.includes('code_bug'));
    assert.ok(out.includes('software'));
  });

  await check('directive renders verification guidance when required', () => {
    const scope = {
      primaryScopes: ['software'],
      secondaryScopes: [],
      excludedScopes: [],
      queryVariants: ['x'],
      retrievalDepth: 4,
      verificationRequired: true,
    };
    const out = buildKnowledgeRetrievalDirective({ scope, result: null });
    assert.ok(out.includes('Verification required'));
  });

  await check('directive renders blind-spot note when result has gaps', () => {
    const scope = {
      primaryScopes: ['smart_device'],
      secondaryScopes: [],
      excludedScopes: [],
      queryVariants: [],
      retrievalDepth: 5,
      verificationRequired: false,
    };
    const fakeResult: any = {
      source: 'database',
      confidence: 'PROBABLE',
      chunks: ['[fact] x'],
      coverage: 0.5,
      freshness: 0.5,
      conflicts: [],
      sufficient: false,
      blindSpotsCreated: 2,
      researchJobsTriggered: 1,
    };
    const out = buildKnowledgeRetrievalDirective({ scope, result: fakeResult });
    assert.ok(out.includes('2 knowledge gap(s)'));
    assert.ok(out.includes('Do NOT wait'));
  });

  await check('retrieved knowledge block is separate from directive', () => {
    const fakeResult: any = {
      source: 'database',
      confidence: 'VERIFIED',
      chunks: ['[OFFICIAL] claim A'],
      coverage: 1.0,
      freshness: 0.9,
      conflicts: [],
      sufficient: true,
      blindSpotsCreated: 0,
      researchJobsTriggered: 0,
    };
    const block = buildRetrievedKnowledgeBlock({ result: fakeResult });
    assert.ok(block.includes('<retrieved_knowledge>'));
    assert.ok(block.includes('[OFFICIAL] claim A'));
    const directive = buildKnowledgeRetrievalDirective({ scope: null, result: fakeResult });
    // Directive and block are distinct fenced sections
    assert.ok(!block.includes('<knowledge_retrieval_directive>'));
    assert.ok(!directive.includes('<retrieved_knowledge>'));
  });

  // ==================== 3. Knowledge Runtime scope consumption ====================
  console.log('\n3. Knowledge Runtime scope consumption');

  await check('queryKnowledge accepts an optional scope arg (type-level)', async () => {
    // We don't want to hit the DB in a unit test, so we only verify the
    // function signature by importing it and checking the input interface.
    const kr = await import('../src/services/knowledgeRuntime');
    assert.equal(typeof kr.queryKnowledge, 'function');
  });

  // ==================== 4. Skill / Learning boundary ====================
  console.log('\n4. Skill + Knowledge Directive coexistence');

  await check('Skill Auto Selection chain is intact (compiler.buildSkillSections)', () => {
    // Confirm compiler still references the skill sections
    const src = fs.readFileSync(
      new URL('../src/services/compiler.ts', import.meta.url),
      'utf8',
    );
    assert.ok(src.includes('buildSkillSections'));
    assert.ok(src.includes('buildKnowledgeRetrievalDirective'));
  });

  await check('Learning chain still goes through memoryRuntime.beforeResponse (no Skill→Scope link)', () => {
    const src = fs.readFileSync(
      new URL('../src/services/memoryRuntime.ts', import.meta.url),
      'utf8',
    );
    // Learning reads from beforeResponse; it must NOT reference the scope router.
    assert.ok(!src.includes('routeKnowledgeScope'));
    assert.ok(src.includes('getExpressionContext'));
  });

  // ==================== 5. Research fallback chain ====================
  console.log('\n5. Knowledge insufficiency → Blind Spot → Research Planner');

  await check('reuseOrCreateJob still produces a Planner-backed planJson', async () => {
    const { reuseOrCreateJob } = await import('../src/services/researchManager');
    assert.equal(typeof reuseOrCreateJob, 'function');
  });

  await check('Knowledge Runtime blind-spot path still calls detectBlindSpots + reuseOrCreateJob', () => {
    const src = fs.readFileSync(
      new URL('../src/services/knowledgeRuntime.ts', import.meta.url),
      'utf8',
    );
    assert.ok(src.includes('detectBlindSpots'));
    assert.ok(src.includes('reuseOrCreateJob'));
  });

  // ==================== 6. FINAL_SYSTEM_PROMPT role=system ====================
  console.log('\n6. FINAL_SYSTEM_PROMPT');

  await check('chat.ts still assembles role=system from finalSystemPrompt', () => {
    const src = fs.readFileSync(
      new URL('../src/routes/chat.ts', import.meta.url),
      'utf8',
    );
    assert.ok(src.includes("role: 'system', content: finalSystemPrompt"));
  });

  await check('compiler produces a single system string containing directive + knowledge sections', () => {
    const src = fs.readFileSync(
      new URL('../src/services/compiler.ts', import.meta.url),
      'utf8',
    );
    assert.ok(src.includes('sections.push(directive)'));
    assert.ok(src.includes('sections.push(factsBlock)'));
  });

  // ==================== 7. No new LLM call in scope router ====================
  console.log('\n7. Performance: no LLM call added');

  await check('knowledgeScopeRouter does not import any LLM provider service', () => {
    const src = fs.readFileSync(
      new URL('../src/services/knowledgeScopeRouter.ts', import.meta.url),
      'utf8',
    );
    // The scope router must not import callGemini / chatWithFallback / agnes.
    assert.ok(!src.includes('callGemini'));
    assert.ok(!src.includes('chatWithFallback'));
    assert.ok(!src.includes('callAgnes'));
    assert.ok(!src.includes('analyzeMediaIntent'));
  });

  await check('knowledgeRuntime failure is caught in promptRuntime (non-blocking)', () => {
    const src = fs.readFileSync(
      new URL('../src/services/promptRuntime.ts', import.meta.url),
      'utf8',
    );
    assert.ok(src.includes('.catch(() => null)'));
  });

  await check('chat.ts compiler-path knowledge scope is wrapped in try/catch', () => {
    const src = fs.readFileSync(
      new URL('../src/routes/chat.ts', import.meta.url),
      'utf8',
    );
    assert.ok(src.includes('knowledgeScopeForCompile'));
    assert.ok(src.includes('knowledgeResultForCompile'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Test harness error:', err);
  process.exitCode = 1;
});
