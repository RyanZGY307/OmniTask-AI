// S6 验收：能力面开关——AgentLoop.capabilities() 五布尔如实反映依赖注入；
// 未注入的能力 = false（UI 显示「不可用」，不得伪造）。L1 纯逻辑，无 DB。

process.env.DATABASE_URL_USER ||= 'postgresql://u:p@127.0.0.1:5432/cortex_user?connection_limit=1';
process.env.DATABASE_URL_CONVERSATION ||= 'postgresql://u:p@127.0.0.1:5432/cortex_conversation?connection_limit=1';
process.env.DATABASE_URL_KNOWLEDGE ||= 'postgresql://u:p@127.0.0.1:5432/cortex_knowledge?connection_limit=1';
process.env.DATABASE_URL_OVERFLOW ||= 'postgresql://u:p@127.0.0.1:5432/cortex_overflow?connection_limit=1';

const { AgentLoop } = require('../src/agent/runtime/agentLoop');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

// 最小假依赖（纯内存，不触网不触 DB）
function fakeDeps(extra: any = {}) {
  const events: any[] = [];
  const store = {
    async append(runId: string, draft: any) { const e = { id: `e${events.length}`, runId, seq: events.length, ts: new Date().toISOString(), ...draft }; events.push(e); return e; },
    async appendBatch(runId: string, drafts: any[]) { return drafts.map((d) => store.append(runId, d)); },
    async getEvents(runId: string) { return events.filter((e) => e.runId === runId); },
  };
  const model = { async chat() { return { text: '', toolCalls: [], finishReason: 'stop', usage: { source: 'estimated', precision: 'low' } }; }, async *chatStream() {}, async describe() { return { modelKey: 'sim' }; } };
  const tools = { get() { return undefined; }, listEnabled() { return []; }, async execute() { return { ok: true, output: {} }; } };
  const approvals = { request() { throw new Error('unused'); }, decide() { return { ok: true }; }, authorize() { return { ok: false, reason: 'unused' }; }, expireForRun() {}, pendingFor() { return []; }, get() { return undefined; } };
  return { store, model, tools, approvals, ...extra };
}

// 1) 全部可选能力未注入 → 五布尔全 false（宿主当前形态：S6 红线——不可用不伪造）
{
  const loop = new AgentLoop(fakeDeps());
  const caps = loop.capabilities();
  check('未注入 → 五能力全 false', caps.checkpoints === false && caps.subagents === false && caps.skills === false && caps.advisor === false && caps.mcp === false, JSON.stringify(caps));
  check('  恰好五个键（契约不增不减）', Object.keys(caps).sort().join(',') === 'advisor,checkpoints,mcp,skills,subagents');
}

// 2) 逐个注入 → 对应布尔翻 true，其余保持 false（面板逐项可用）
{
  const cases: [string, any][] = [
    ['checkpoints', { tick: async () => ({ id: 'cp1' }) }],
    ['subagents', { run: async () => ({}) }],
    ['skills', { list: () => [] }],
    ['advisor', { advise: async () => ({ agree: true, objections: [], suggestion: '' }) }],
    ['mcp', { listTools: async () => [] }],
  ];
  for (const [key, dep] of cases) {
    const loop = new AgentLoop(fakeDeps({ [key]: dep }));
    const caps = loop.capabilities();
    const others = Object.entries(caps).filter(([k]) => k !== key);
    check(`注入 ${key} → 仅 ${key}=true`, (caps as any)[key] === true && others.every(([, v]) => v === false), JSON.stringify(caps));
  }
}

// 3) 全注入 → 全 true
{
  const loop = new AgentLoop(fakeDeps({
    checkpoints: { tick: async () => ({ id: 'cp' }) },
    subagents: { run: async () => ({}) },
    skills: { list: () => [] },
    advisor: { advise: async () => ({ agree: true, objections: [], suggestion: '' }) },
    mcp: { listTools: async () => [] },
  }));
  const caps = loop.capabilities();
  check('全注入 → 五能力全 true', Object.values(caps).every((v) => v === true), JSON.stringify(caps));
}

// 4) 注入假值（undefined/null）仍视为未注入（防御：面板不得把空对象当可用）
{
  const loop = new AgentLoop(fakeDeps({ checkpoints: undefined, skills: null }));
  const caps = loop.capabilities();
  check('注入 undefined/null → 仍 false（不伪造）', caps.checkpoints === false && caps.skills === false);
}

console.log(`\nS6 能力面开关：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail > 0 ? 1 : 0;
