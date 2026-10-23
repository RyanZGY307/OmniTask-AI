// ================================================================
// 计算下沉策略测试
// Run: npx tsx test/computePlacement.test.ts
// 重点验证「危险下沉被拦住」而不只是「该下沉的下沉了」。
// ================================================================

import { classify, PLATFORM_TASKS, summarize, requiresFallback, type ComputeTask } from '../src/services/computePlacement';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = '') =>
  c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, d));
const S = (n: string) => console.log('\n=== ' + n + ' ===');

const base: ComputeTask = {
  id: 't', label: 't', category: 'transform', weight: 3,
  needsSecret: false, clientOnlyInput: true, outputScopedToUser: true, hasFallback: true,
};
const t = (o: Partial<ComputeTask>): ComputeTask => ({ ...base, ...o });

S('1. R1 机密一票否决（安全规则优先于一切）');
{
  check('needsSecret 强制服务端', classify(t({ needsSecret: true, weight: 5 })).verdict === 'server');
  check('触发 R1 规则', classify(t({ needsSecret: true })).rule === 'R1-secret');

  // 即使自称纯变换也不能下沉
  check('机密+纯变换仍留服务端', classify(t({ category: 'transform', needsSecret: true })).verdict === 'server');
  check('机密+有 fallback 仍留服务端', classify(t({ needsSecret: true, hasFallback: true })).verdict === 'server');

  for (const cat of ['ai-call', 'embedding', 'auth', 'billing', 'audit', 'crypto'] as const) {
    const d = classify(t({ category: cat, needsSecret: false }));
    check(`${cat} 品类强制服务端`, d.verdict === 'server', d.verdict);
  }
}

S('2. R2/R3 信任边界与跨用户');
{
  for (const cat of ['billing', 'audit', 'db-write', 'auth'] as const) {
    check(`${cat} 信任边界留服务端`, classify(t({ category: cat })).verdict === 'server');
  }
  check('aggregate 品类留服务端', classify(t({ category: 'aggregate' })).verdict === 'server');
  check('输入非客户端持有 → 服务端', classify(t({ clientOnlyInput: false })).verdict === 'server');
  check('输出跨用户 → 服务端', classify(t({ outputScopedToUser: false })).verdict === 'server');
  check('跨用户输出触发 R3', classify(t({ outputScopedToUser: false })).rule === 'R3-aggregation');
}

S('3. R4 合法下沉条件');
{
  const ok = classify(t({ weight: 5, hasFallback: true }));
  check('重计算+全集条件 → client', ok.verdict === 'client', ok.verdict);
  check('触发 R4 规则', ok.rule === 'R4-offload');

  const light = classify(t({ weight: 2 }));
  check('轻计算留服务端（收益低于序列化开销）', light.verdict === 'server', light.verdict);

  const noFb = classify(t({ weight: 5, hasFallback: false }));
  check('无 fallback → 降级为 client-with-fallback', noFb.verdict === 'client-with-fallback', noFb.verdict);
  check('requiresFallback 识别待补降级路径', requiresFallback(base) === false && requiresFallback(t({ weight: 5, hasFallback: false })) === true);
}

S('4. 平台真实任务的归类结论（防规则漂移）');
{
  const byId = new Map(PLATFORM_TASKS.map((x) => [x.id, x]));
  const mustServer = [
    'ai.chat', 'ai.embedding', 'ai.rerank', 'auth.jwt.verify',
    'billing.deduct', 'trace.write', 'stats.admin',
  ];
  for (const id of mustServer) {
    const x = byId.get(id);
    check(`${id} 必须留服务端`, !!x && classify(x!).verdict === 'server', x ? classify(x).verdict : 'missing');
  }

  // 用户原话要求「计算量高的放前端」——这些正是可搬的重活
  const movable = ['history.parse', 'content.markdown', 'docgen.pdf', 'media.thumbnail', 'search.filter'];
  for (const id of movable) {
    const x = byId.get(id);
    check(`${id} 可下沉`, !!x && classify(x!).verdict !== 'server', x ? classify(x).verdict : 'missing');
  }

  const s = summarize();
  check('汇总：可下沉项数与任务数一致', s.movable.length + s.mustStayServer.length === PLATFORM_TASKS.length);
  check('汇总：可下沉项中不含任何机密任务', s.movable.every((r) => !byId.get(r.id)!.needsSecret));

  // 最大重量项应在服务端（AI 调用），不能出现在下沉列表
  const heaviest = PLATFORM_TASKS.reduce((a, b) => (a.weight >= b.weight ? a : b));
  check('最重的任务留服务端（不得为下沉而搬机密）', classify(heaviest).verdict === 'server', heaviest.id);
  check('下沉优先级按重量降序', s.movableByWeight.every((r, i, a) => i === 0 || a[i - 1].weight >= r.weight));
}

S('5. 边界与不变式');
{
  // 不变式：任何 needsSecret 的任务在任何字段组合下都不能下沉
  const combos: Partial<ComputeTask>[] = [
    {}, { weight: 5 }, { hasFallback: true }, { clientOnlyInput: true },
    { outputScopedToUser: true }, { category: 'transform' }, { category: 'docgen' },
  ];
  for (const c of combos) {
    check(`needsSecret + ${JSON.stringify(c)} → 服务端`,
      classify(t({ needsSecret: true, ...c })).verdict === 'server');
  }
  check('所有平台任务 id 唯一', new Set(PLATFORM_TASKS.map((x) => x.id)).size === PLATFORM_TASKS.length);
  check('weight 取值合法', PLATFORM_TASKS.every((x) => [1, 2, 3, 4, 5].includes(x.weight)));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
