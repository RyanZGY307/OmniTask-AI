// ================================================================
// 基准脚本：提示词/技能选择链路的延迟与每请求查询次数（todo 5）
// 运行：npx tsx scripts/benchmark-prompt.ts
//
// 不连真实数据库：拦截 './db' 模块加载，注入可控行数的内存假库，
// 因此本脚本可在任何环境（含 CI、离线）重复运行，输出可比对。
// 三个关注点：
//   A. 技能选择延迟（零 AI、确定性选择器的绝对延迟）
//   B. 场景候选 atom 检索延迟随 atom 规模的增长（20/100/500/1000）
//   C. 单次请求的组合链查询次数（必须 = 1：一份快照，全链复用）
// ================================================================

import Module from 'module';

// —— 可控假库 ---------------------------------------------------
let atomRows: any[] = [];
let compatCalls = 0;
let findManyCalls = 0;

function rebuildAtoms(n: number) {
  atomRows = [];
  for (let i = 0; i < n; i++) {
    atomRows.push({
      id: `task.bench_${i}`,
      category: i % 7 === 0 ? 'core' : 'task',
      version: '1.0.0',
      priority: i % 100,
      status: 'published',
      requires: '[]', conflicts_with: '[]', compatible_with: '[]', extends: '[]', tags: '[]', parent: null,
      // getActiveVersions() includes only versions with status='published'
      // and then drops atoms that have none — so a row without this is
      // invisible to the snapshot (and to composePrompt).
      versions: [{ version: '1.0.0', instruction: `Benchmark instruction for atom ${i}.`, status: 'published' }],
    });
  }
}

const fakeDb = {
  prismaKnowledge: {
    promptAtom: {
      findMany: async ({ where }: any) => {
        findManyCalls++;
        let rows = atomRows.filter((a) => a.status === 'published');
        if (where?.id?.in) rows = rows.filter((a) => where.id.in.includes(a.id));
        if (where?.id?.notIn) rows = rows.filter((a) => !where.id.notIn.includes(a.id));
        // orderBy priority desc（检索层 top-up 的顺序）
        rows = [...rows].sort((a, b) => b.priority - a.priority);
        return where?.take ? rows.slice(0, where.take) : rows;
      },
    },
    promptAtomVersion: {},
    scenario: {
      // 每 500 个 atom 才有一个 related 的「已引用」atom，逼出真实的 top-up 路径
      findUnique: async ({ where }: any) => (where?.id === 'bench.scenario'
        ? { id: 'bench.scenario', max_atoms: 12, required_atoms: JSON.stringify([atomRows[3]?.id ?? 'x']), exclude_atoms: JSON.stringify([atomRows[4]?.id ?? 'x']) }
        : null),
      findMany: async () => [], count: async () => 0, upsert: async () => ({}), update: async () => ({}),
    },
    scenarioPromptCompat: {
      findUnique: async () => { compatCalls++; return null; },
    },
  },
};

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any) {
  if (request === './db' && parent && String(parent.filename).includes('services')) return fakeDb;
  if (request === '../db' && parent && String(parent.filename).includes('scenarioWorkers')) return fakeDb;
  return origLoad.apply(this, arguments as any);
};

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    avg: +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(4),
    p50: +q(0.5).toFixed(4),
    p95: +q(0.95).toFixed(4),
    max: +s[s.length - 1].toFixed(4),
  };
}

(async () => {
  const { selectSkills, getSkillSelectionMetrics } = await import('../src/services/skillSelector');
  const { retrieveCandidateAtoms } = await import('../src/services/scenarioWorkers/scenarioRetrieval');
  const { getActiveVersions } = await import('../src/services/promptRegistry');
  const { resolveDependencies } = await import('../src/services/dependencyResolver');
  const { resolveConflicts } = await import('../src/services/conflictResolver');
  const { composePrompt } = await import('../src/services/promptComposer');

  const p1: any = { domain: 'coding', scenario_signature: 'coding:web', intent: 'build', contextual_features: [] };
  const p2: any = { matched_scenario_id: 'bench.scenario', resolution: 'reuse' };

  // —— A. 技能选择延迟 -------------------------------------------------
  console.log('\n[A] Skill selection latency (deterministic, zero AI)');
  const inputs = [
    { message: '帮我写一个 python 脚本分析这份销售数据', taskType: 'coding', userTier: 'PRO' },
    { message: '搜索最新的 AI 行业新闻并总结', taskType: 'research', userTier: 'STANDARD' },
    { message: '把这段中文翻译成英文', taskType: 'translation', userTier: 'STANDARD' },
    { message: '你好呀今天天气不错', taskType: 'answer', userTier: 'STANDARD' },
  ];
  const A_ITERS = 5000;
  const aSamples: number[] = [];
  const decisions: Record<string, number> = {};
  for (let i = 0; i < A_ITERS; i++) {
    const r = selectSkills(inputs[i % inputs.length]);
    aSamples.push(r.elapsedMs);
    decisions[r.decision] = (decisions[r.decision] ?? 0) + 1;
  }
  const a = stats(aSamples);
  console.log(`  iterations      ${A_ITERS}`);
  console.log(`  avg / p50 / p95 / max   ${a.avg} / ${a.p50} / ${a.p95} / ${a.max} ms`);
  console.log(`  decisions       ${JSON.stringify(decisions)}`);
  console.log(`  process metrics ${JSON.stringify(getSkillSelectionMetrics())}`);

  // —— B. 候选 atom 检索延迟随规模增长 ----------------------------------
  console.log('\n[B] Scenario candidate-atom retrieval latency vs atom count');
  console.log('  atoms    calls   avg(ms)  p95(ms)   fillers(clamped<=20)');
  const B_CALLS = 300;
  const bRows: Array<{ n: number; avg: number; p95: number; size: number }> = [];
  for (const n of [20, 100, 500, 1000]) {
    rebuildAtoms(n);
    const samples: number[] = [];
    let lastSize = 0;
    for (let i = 0; i < B_CALLS; i++) {
      const t0 = performance.now();
      const cands = await retrieveCandidateAtoms({ p1, p2 });
      samples.push(performance.now() - t0);
      lastSize = cands.length;
    }
    const s = stats(samples);
    bRows.push({ n, avg: s.avg, p95: s.p95, size: lastSize });
    console.log(`  ${String(n).padStart(5)}  ${String(B_CALLS).padStart(6)}   ${String(s.avg).padStart(7)}  ${String(s.p95).padStart(7)}   ${lastSize}`);
  }
  const growth = +(bRows[bRows.length - 1].avg / Math.max(bRows[0].avg, 1e-6)).toFixed(1);
  console.log(`  1000 vs 20 atoms: ${growth}x latency — a scan-shaped lookup, not an index-shaped one.`);
  console.log('  NOTE: measured against an in-memory stub (JS filter/sort), NOT Postgres.');
  console.log('        It sizes the JS-side policy/top-up/re-assemble work only; real SQL latency');
  console.log('        and row counts need a connected DB (CORTX_ATOM_BENCH_DB=1).');

  // —— C. 单请求组合链的查询次数 ----------------------------------------
  console.log('\n[C] One request = one snapshot query');
  rebuildAtoms(200);
  findManyCalls = 0;
  const t0 = performance.now();
  const versions = await getActiveVersions({ force: true });       // 1 query — the snapshot
  const afterSnapshot = findManyCalls;
  const atoms = await retrieveCandidateAtoms({ p1, p2 });          // its own SQL (policy + top-up)
  const afterRetrieve = findManyCalls;
  const candidateIds = atoms.map((c) => c.atom.id);
  const dep = await resolveDependencies(candidateIds, versions);   // must add 0 queries
  const afterDep = findManyCalls;
  const con = await resolveConflicts(dep.resolved_atoms, versions);            // must add 0
  const composed = await composePrompt(con.final_atoms, { language: 'zh' }, { versions }); // must add 0
  const chainMs = performance.now() - t0;

  console.log(`  snapshot queries        ${afterSnapshot}`);
  console.log(`  retrieveCandidateAtoms  ${afterRetrieve - afterSnapshot} (policy + top-up: uses its own SQL by design)`);
  console.log(`  indirect queries added by resolveDependencies   ${afterDep - afterRetrieve}`);
  console.log(`  indirect queries added by resolveConflicts      ${findManyCalls - afterDep}`);
  console.log(`  => resolver+compose chain re-queries the registry: ${afterDep - afterRetrieve > 0 || findManyCalls - afterDep > 0 ? 'YES (regression)' : 'NO (snapshot shared)'}`);
  console.log(`  snapshot entries        ${Object.keys(versions).length} (200 published atoms)`);
  console.log(`  candidates -> resolved  ${candidateIds.length} -> ${dep.resolved_atoms.length} -> composed ${con.final_atoms.length}`);
  console.log(`  composed sections       ${Object.keys(composed.sections).join(',')}`);
  console.log(`  chain elapsed           ${chainMs.toFixed(2)} ms`);
  console.log(`  final prompt length     ${composed.final_prompt.length} chars`);

  const ok = afterSnapshot === 1
    && afterDep - afterRetrieve === 0
    && findManyCalls - afterDep === 0
    && con.final_atoms.length > 0;
  console.log(ok
    ? '\nRESULT: PASS — one snapshot query, zero re-queries, non-empty composition'
    : `\nRESULT: FAIL — snapshot=${afterSnapshot} depQueries=${afterDep - afterRetrieve} composeQueries=${findManyCalls - afterDep} atoms=${con.final_atoms.length}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
