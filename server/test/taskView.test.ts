// S5 验收：UI 状态契约投影测试（移植自 OmniTask-Agent test/ui.test.ts 共 6 例）
// 口径：L1 纯函数级，无 DB、无 DOM。投影唯一事实源 = 事件数组（模拟 EventStore.getEvents 返回）。
// 与 agent 侧唯一差异：宿主 tsconfig 无 allowImportingTsExtensions，import 不带 .ts 后缀。

process.env.DATABASE_URL_USER ||= 'postgresql://u:p@127.0.0.1:5432/cortex_user?connection_limit=1';
process.env.DATABASE_URL_CONVERSATION ||= 'postgresql://u:p@127.0.0.1:5432/cortex_conversation?connection_limit=1';
process.env.DATABASE_URL_KNOWLEDGE ||= 'postgresql://u:p@127.0.0.1:5432/cortex_knowledge?connection_limit=1';
process.env.DATABASE_URL_OVERFLOW ||= 'postgresql://u:p@127.0.0.1:5432/cortex_overflow?connection_limit=1';

const { projectTaskCard, summarizeEvent, toEventRows } = require('../src/agent/ui/taskView');
const typeCheck = require('../src/agent/events/types');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

function ev(seq: number, type: string, payload: Record<string, unknown>, level: string = 'info') {
  return { id: `e${seq}`, runId: 'r1', seq, type, level, ts: new Date().toISOString(), payload };
}

// ---- 1. 完整生命周期各阶段 ----
{
  const events = [
    ev(1, 'run.created', { taskId: 't', userId: 'u' }),
    ev(2, 'pattern.selected', { pattern: 'react', label: 'ReAct', reason: '中复杂度' }),
    ev(3, 'run.depth_decided', { depth: 'd2' }),
    ev(4, 'run.started', {}),
    ev(5, 'step.started', { seq: 1, title: '读取文件' }),
    ev(6, 'tool.result', { toolId: 'read_file@1.0.0', ok: true }),
    ev(7, 'run.completed', { finalText: '已完成勘察。' }),
  ];
  const card = projectTaskCard(events);
  check('生命周期 → completed', card.phase === 'completed');
  check('  pattern=react', card.pattern === 'react');
  check('  steps=1', card.steps === 1);
  check('  finalText 透传', card.finalText === '已完成勘察。');
  check('  lastEventSeq=7', card.lastEventSeq === 7);
}

// ---- 2. 审批门挂起→决定→running ----
{
  const events = [
    ev(1, 'run.started', {}),
    ev(2, 'approval.requested', { approvalId: 'ap1', summary: 'rm build' }, 'warn'),
  ];
  const mid = projectTaskCard(events);
  check('挂起 → waiting_approval', mid.phase === 'waiting_approval');
  check('  approvalsPending=1', mid.approvalsPending === 1);
  const after = projectTaskCard([...events, ev(4, 'approval.decided', { approvalId: 'ap1', decision: 'denied' })]);
  check('  decided → running', after.phase === 'running');
  check('  approvalsPending 回 0', after.approvalsPending === 0);
}

// ---- 3. 失败/预算耗尽带 errorKind ----
{
  const f = projectTaskCard([ev(1, 'run.failed', { errorKind: 'rate_limited' }, 'error')]);
  check('run.failed → failed + errorKind', f.phase === 'failed' && f.errorKind === 'rate_limited');
  const b = projectTaskCard([ev(1, 'run.budget_exhausted', { reason: 'maxSteps' }, 'warn')]);
  check('budget_exhausted → phase + reason', b.phase === 'budget_exhausted' && b.errorKind === 'maxSteps');
}

// ---- 4. 降级与压缩如实记录 ----
{
  const c = projectTaskCard([ev(1, 'pattern.downgraded', { from: 'multi_agent', to: 'plan_execute' }, 'warn')]);
  check('pattern.downgraded 记录 from', c.downgradedFrom === 'multi_agent');
  const k = projectTaskCard([ev(1, 'run.compacted', { level: 'c2', origin: 30, kept: 6 })]);
  check('run.compacted → compacting', k.phase === 'compacting');
}

// ---- 5. 摘要：关键事件有一行人话 ----
{
  check('tool.requested 摘要含 r2', /r2/.test(summarizeEvent(ev(1, 'tool.requested', { toolId: 'bash@1.0.0', riskLevel: 'r2' }))));
  check('run.compacted 摘要含 c2', /c2/.test(summarizeEvent(ev(2, 'run.compacted', { level: 'c2', origin: 30, kept: 6 }))));
  const rows = toEventRows([ev(1, 'run.created', {}), ev(2, 'run.started', {})]);
  check('toEventRows 行数/seq', rows.length === 2 && rows[1].seq === 2);
}

// ---- 6. 接线：EventStore 接口事件流 → 卡片（内存 store 模拟 getEvents）----
{
  // 最小内存 EventStore（仅实现投影用到的 append/getEvents），不进生产
  const mem: any[] = [];
  const store = {
    async append(runId: string, draft: any) {
      const e = { id: `e${mem.length + 1}`, runId, seq: mem.length + 1, ts: new Date().toISOString(), ...draft };
      mem.push(e);
      return e;
    },
    async getEvents(runId: string) { return mem.filter((e) => e.runId === runId); },
  };
  (async () => {
    await store.append('r1', { type: 'run.created', level: 'info', payload: { taskId: 't', userId: 'u', depth: 'd2', modelTier: 'standard' } });
    await store.append('r1', { type: 'pattern.selected', level: 'info', payload: { pattern: 'plan_execute', label: 'Plan+Execute', reason: '复杂' } });
    await store.append('r1', { type: 'userinput.requested', level: 'info', payload: { requestId: 'ui1', prompt: '目标文件？' } });
    const card = projectTaskCard(await store.getEvents('r1'));
    check('EventStore 流 → waiting_user', card.phase === 'waiting_user');
    check('  userInputsPending=1', card.userInputsPending === 1);

    // TaskPhase 11 态全覆盖（runbook S5 验收：11 态随事件翻转）
    const PHASES = ['created','selected','running','waiting_approval','waiting_user','compacting','restoring','completed','failed','canceled','budget_exhausted'];
    const seq: [string, Record<string, unknown>][] = [
      ['run.created', {}], ['pattern.selected', { pattern: 'react', label: 'ReAct' }], ['run.started', {}],
      ['approval.requested', { approvalId: 'a' }], ['userinput.requested', { requestId: 'u' }], ['run.compacted', { level: 'c2' }],
      ['run.restored', {}], ['run.completed', { finalText: 'ok' }], ['run.failed', { errorKind: 'x' }],
      ['run.canceled', {}], ['run.budget_exhausted', { reason: 'maxSteps' }],
    ];
    let allOk = true;
    const seen: string[] = [];
    for (const [t, p] of seq) {
      const c = projectTaskCard([ev(1, t, p)]);
      seen.push(c.phase);
      if (!PHASES.includes(c.phase)) allOk = false;
    }
    check('TaskPhase 11 态齐全且每态可达', allOk && new Set(seen).size === 11, JSON.stringify(seen));

    console.log(`\nS5 UI 投影：${pass} 通过 / ${fail} 失败`);
    process.exitCode = fail > 0 ? 1 : 0;
  })().catch((e) => { console.error('崩溃:', e); process.exit(1); });
}
