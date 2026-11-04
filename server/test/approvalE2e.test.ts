// S4 e2e 冒烟：r2 工具 → waiting_approval → 人工 decide → resume → execute → completed
// （runbook S4 验收口径的「一个可执行闭环」，按 toolTurn 真实契约编写）
//
// 覆盖链路（全部纯逻辑、无 DB；模型为模拟客户端，显式 simulated —— L2 口径，
// 绝不宣称真实模型验证）：
//   toolTurn（runner）assessRisk 定级 → r2 无 forcedApprovalId → approvals.request
//     → emit approval.requested（宿主 UI 卡片数据源：summary）→ kind=waiting_approval
//     → 人工 decide(by=真实 userId) → 桥接层补发 approval.decided（by=人）
//     → resume（forcedApprovalId）→ authorize 复检 → tools.execute → emit tool.result → kind=ok
// 红线断言：未决定 authorize 拒 / decide denied → kind=denied / 跨 Run 复用拒 /
//           指纹漂移拒 / 幂等指纹已成功 → skipped_idempotent（副作用不重放）

process.env.DATABASE_URL_USER ||= 'postgresql://u:p@127.0.0.1:5432/cortex_user?connection_limit=1';
process.env.DATABASE_URL_CONVERSATION ||= 'postgresql://u:p@127.0.0.1:5432/cortex_conversation?connection_limit=1';
process.env.DATABASE_URL_KNOWLEDGE ||= 'postgresql://u:p@127.0.0.1:5432/cortex_knowledge?connection_limit=1';
process.env.DATABASE_URL_OVERFLOW ||= 'postgresql://u:p@127.0.0.1:5432/cortex_overflow?connection_limit=1';

// require 而非 import：env 赋值必须在模块加载前完成（同 permissionEngine.test.ts 理由）
const { toolTurn } = require('../src/agent/runtime/runner');
const { HostApprovalService } = require('../src/agent/policy/hostApprovalService');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}
const SECTION = (n: string) => console.log('\n' + n);

// —— 最小 RunEnv：内存事件存储 + 模拟模型 + 一个 r2 写工具 ——
function makeEnv() {
  const events: any[] = [];
  const store = {
    async append(runId: string, draft: any) {
      const e = { id: `${runId}#${events.length + 1}`, seq: events.length + 1, ts: new Date().toISOString(), runId, ...draft };
      events.push(e);
      return e;
    },
  };
  // 模拟模型客户端（L2：simulated=true 显式标注）
  const model = {
    simulated: true,
    async chat() {
      return {
        text: '[simulated] ok', toolCalls: [], finishReason: 'stop', latencyMs: 1,
        usage: { source: 'estimated', precision: 'low', estimator: 'chars/4' },
        modelRef: { modelKey: 'sim', provider: 'sim', tier: 'standard' },
        capabilitySnapshot: { provider: 'sim', contextWindow: 8192, tier: 'standard' },
        simulated: true,
      };
    },
    async *chatStream() { yield { type: 'text', text: '[simulated]' }; },
    async describe() { return { modelKey: 'sim', provider: 'sim' }; },
  };
  let execCount = 0;
  const spec = {
    id: 'fs.write@1.0.0', name: 'fs_write', description: '写文件（r2）',
    inputSchema: { type: 'object', required: ['path', 'content'] },
    riskLevel: 'r2', sideEffects: 'non_idempotent', workspaceRoots: ['/w'],
    timeoutMs: 5000, outputBudgetTokens: 1000,
  };
  const tools = {
    get(id: string) { return id === spec.id ? spec : undefined; },
    async execute(id: string, args: any) {
      execCount++;
      return { ok: true, output: { written: args.path, bytes: String(args.content).length, execNo: execCount } };
    },
  };
  const approvals = new HostApprovalService({ userId: 'u-e2e', inMemoryOnly: true, store });
  const env = { store, model, tools, approvals };
  return { env, events, approvals, getExecCount: () => execCount };
}

function runCtx(over: any = {}) {
  return {
    runId: 'run-e2e-1', taskId: 'task-e2e-1', userId: 'u-e2e', conversationId: 'c1',
    objective: '写文件', userMessage: '帮我写 /w/a.txt', history: [], tier: 'standard', depth: 'd1',
    workspaceRoots: ['/w'], limits: { maxSteps: 10, maxModelCalls: 10 },
    signals: { dependencyDepth: 0, goalAmbiguity: 0, riskSideEffect: 0, irreversibility: 0, externalToolNeed: 0, recoveryCost: 0, verifiability: 0 },
    ...over,
  };
}

(async () => {
  SECTION('S4 e2e：r2 工具审批闭环（runbook S4 验收用例）');

  // 1) 首调 → waiting_approval + approval.requested 事件（UI 卡片数据源）
  {
    const m = makeEnv();
    const call = { id: 'call_1', name: 'fs.write@1.0.0', args: { path: '/w/a.txt', content: 'hello' } };
    const argsJson = JSON.stringify(call.args);
    const r = await toolTurn(m.env, runCtx(), { stepId: 'step_1', call, argsJson, idemKey: 'step_1:call_1' });
    check('r2 首调 → kind=waiting_approval', r.kind === 'waiting_approval', JSON.stringify(r).slice(0, 200));
    const apId = r.approvalId;
    check('  返回 approvalId + decisionKey', typeof apId === 'string' && r.decisionKey === `fs.write@1.0.0|${argsJson}`);
    const reqEv = m.events.find((e) => e.type === 'approval.requested');
    check('  事件流含 approval.requested', !!reqEv);
    check('  卡片 summary 非空且含工具 id（runbook：卡片从 summary 渲染）', String(reqEv?.payload?.summary ?? '').includes('fs.write@1.0.0'), JSON.stringify(reqEv?.payload?.summary));
    check('  审批状态 pending（未放行）', m.approvals.get(apId!)?.state === 'pending');
    check('  工具尚未执行（execCount=0）', m.getExecCount() === 0);

    // 2) 未决定 → authorize 拒（禁自动放行）
    check('未决定 authorize → not_decided', m.approvals.authorize('run-e2e-1', apId!, 'fs.write@1.0.0', argsJson).reason === 'not_decided');

    // 3) 人工 decide（by=人类 id；桥接层补发 approval.decided，by 必须是人）
    const d = m.approvals.decide(apId!, 'approved', 'u-e2e');
    check('人类 decide approved → ok', d.ok === true);
    const decEv = m.events.find((e) => e.type === 'approval.decided');
    check('  桥接层补发 approval.decided', !!decEv);
    check('  approval.decided.by 是人类用户（非 system）', decEv?.payload?.by === 'u-e2e' && decEv?.payload?.decidedBy === 'u-e2e', JSON.stringify(decEv?.payload));

    // 4) resume：forcedApprovalId → authorize 复检 → 执行 → kind=ok
    const r2 = await toolTurn(m.env, runCtx(), { stepId: 'step_1', call, argsJson, idemKey: 'step_1:call_1', forcedApprovalId: apId });
    check('resume 后 kind=ok（completed 语义）', r2.kind === 'ok', JSON.stringify(r2).slice(0, 200));
    check('  工具真的执行了一次', m.getExecCount() === 1 && (r2 as any).result?.output?.written === '/w/a.txt', JSON.stringify((r2 as any).result));
    check('  事件流含 tool.requested + tool.result', m.events.some((e) => e.type === 'tool.requested') && m.events.some((e) => e.type === 'tool.result'));

    // 5) 幂等重放：ctx.replay.succeededToolFingerprints 含该指纹 → skipped_idempotent，不重复执行
    const fp = `fs.write@1.0.0|${argsJson}`;
    const r3 = await toolTurn(m.env, runCtx({ replay: { succeededToolFingerprints: new Set([fp]), note: 'resume' } }), {
      stepId: 'step_2', call: { ...call, id: 'call_1_replay' }, argsJson, idemKey: 'step_2:call_1_replay',
      forcedApprovalId: apId,
    });
    check('已成功指纹重放 → skipped_idempotent', r3.kind === 'skipped_idempotent', JSON.stringify(r3).slice(0, 120));
    check('  副作用未重放（execCount 仍为 1）', m.getExecCount() === 1);
    check('  留痕 tool.replayed_skipped', m.events.some((e) => e.type === 'tool.replayed_skipped'));
  }

  // 6) 拒绝路径：decide denied → resume → kind=denied + step.denied
  {
    const m = makeEnv();
    const call = { id: 'call_2', name: 'fs.write@1.0.0', args: { path: '/w/b.txt', content: 'x' } };
    const argsJson = JSON.stringify(call.args);
    const r = await toolTurn(m.env, runCtx({ runId: 'run-deny' }), { stepId: 's1', call, argsJson, idemKey: 's1:call_2' });
    check('第二个 r2 工具同样先挂起', r.kind === 'waiting_approval');
    m.approvals.decide(r.approvalId!, 'denied', 'u-e2e');
    const rDeny = await toolTurn(m.env, runCtx({ runId: 'run-deny' }), { stepId: 's1', call, argsJson, idemKey: 's1:call_2', forcedApprovalId: r.approvalId });
    check('decide denied → resume kind=denied', rDeny.kind === 'denied', JSON.stringify(rDeny).slice(0, 160));
    check('  工具未执行', m.getExecCount() === 0);
    check('  事件流含 step.denied（reason=denied）', m.events.some((e) => e.type === 'step.denied' && e.payload?.reason === 'denied'));
  }

  // 7) 红线：跨 Run 复用（DEC-02）+ 指纹漂移 + 重复 decide
  {
    const m = makeEnv();
    const call = { id: 'call_3', name: 'fs.write@1.0.0', args: { path: '/w/c.txt', content: 'y' } };
    const argsJson = JSON.stringify(call.args);
    const r = await toolTurn(m.env, runCtx({ runId: 'run-A' }), { stepId: 's1', call, argsJson, idemKey: 'a:c3' });
    const apId = r.approvalId!;
    m.approvals.decide(apId, 'approved', 'u-e2e');
    check('跨 Run 复用 → cross_run_reuse_denied', m.approvals.authorize('run-B', apId, 'fs.write@1.0.0', argsJson).reason === 'cross_run_reuse_denied');
    check('参数漂移 → fingerprint_mismatch', m.approvals.authorize('run-A', apId, 'fs.write@1.0.0', JSON.stringify({ path: '/w/e.txt', content: 'y' })).reason === 'fingerprint_mismatch');
    check('重复 decide 被拒', m.approvals.decide(apId, 'denied', 'u-e2e').ok === false);
  }

  // 8) r3 红线：neverAuto 能力工具首调即 waiting_approval，未批准不放行且不偷跑
  {
    const m = makeEnv();
    const baseSpec = m.env.tools.get('fs.write@1.0.0');
    const spec3 = { ...baseSpec, id: 'vault.get@1.0.0', name: 'vault_get', capabilityTags: ['credential_access'], riskLevel: 'r2' };
    const origGet = m.env.tools.get;
    m.env.tools.get = (id: string) => (id === spec3.id ? spec3 : origGet(id));
    const call = { id: 'c9', name: 'vault.get@1.0.0', args: { key: 'k' } };
    const argsJson = JSON.stringify(call.args);
    const r = await toolTurn(m.env, runCtx({ runId: 'run-r3' }), { stepId: 's1', call, argsJson, idemKey: 'r3:c9' });
    check('neverAuto 工具定级 r3 → waiting_approval', r.kind === 'waiting_approval' && r.risk === 'r3', JSON.stringify(r).slice(0, 200));
    check('  红线：r3 未批准 authorize 拒', m.approvals.authorize('run-r3', r.approvalId!, spec3.id, argsJson).ok === false);
    check('  execCount 仍 0（r3 未偷跑）', m.getExecCount() === 0);
  }

  console.log(`\nS4 e2e 冒烟：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail > 0 ? 1 : 0;
})().catch((e) => { console.error('S4 e2e 崩溃:', e); process.exit(1); });
