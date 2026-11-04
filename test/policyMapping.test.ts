// S4：策略与审批在宿主侧的可执行验证
// （runbook S4 验证口径：agent test/policy.test.ts 11 例在宿主侧通过 + 映射表专属用例）
//
// 被测对象：
//   - agent/policy/risk.ts（定级：档位下限 + 参数级复核升档）
//   - agent/policy/approval.ts（DEC-02 状态机）
//   - agent/policy/riskMapping.ts（r0–r3 ↔ R0–R4 映射 + 决策函数）
//   - agent/policy/hostApprovalService.ts（宿主审批桥接）
//
// 本机限制（如实声明，与 permissionEngine.test.ts 同一口径）：
//   宿主 prisma 查询引擎为 x86_64、运行架构 arm64，dlopen 失败 → DB 断言记 SKIP，
//   绝不用异常兜底伪装 PASS。本文件全部用例均为纯逻辑（无需 DB）。

process.env.DATABASE_URL_USER ||= 'postgresql://u:p@127.0.0.1:5432/cortex_user?connection_limit=1';
process.env.DATABASE_URL_CONVERSATION ||= 'postgresql://u:p@127.0.0.1:5432/cortex_conversation?connection_limit=1';
process.env.DATABASE_URL_KNOWLEDGE ||= 'postgresql://u:p@127.0.0.1:5432/cortex_knowledge?connection_limit=1';
process.env.DATABASE_URL_OVERFLOW ||= 'postgresql://u:p@127.0.0.1:5432/cortex_overflow?connection_limit=1';

// TS import 提升会把 import 排到 env 赋值前执行 → 一律 require（与 P1 测试同一理由）
const {
  assessRisk, isNeverAuto, normalizePath, isInsideWorkspace,
} = require('../src/agent/policy/risk');
const { InMemoryApprovalService } = require('../src/agent/policy/approval');
const {
  RISK_LEVEL_MAP, agentRiskToHostRisk, hostRiskToAgentRisk,
  requiresHumanEachTime, effectiveDecision,
} = require('../src/agent/policy/riskMapping');
const { HostApprovalService, createHostApprovalService } = require('../src/agent/policy/hostApprovalService');
const { DEFAULT_POLICY } = require('../src/agent/policy/hostApprovalService');

// 宿主真值校验（可选）： permissionEngine.ts 顶层 import prisma，本机 PrismaClient
// 构造即 dlopen 失败（x86_64 引擎 vs arm64）→ 加载整个模块就抛。这不是被测代码缺陷，
// 是环境限制（与 permissionEngine.test.ts 同口径）。加载失败时相关断言记 SKIP，
// 绝不用异常兜底伪装 PASS。
let HOST_DEFAULT_POLICY: any; let normalizePolicy: any;
let hostModuleUnavailable: string | undefined;
try {
  ({ DEFAULT_POLICY: HOST_DEFAULT_POLICY, normalizePolicy } = require('../src/connections/permissionEngine'));
} catch (e) {
  hostModuleUnavailable = String(e).split('\n')[0].slice(0, 120);
}
// PrismaClient 构造是异步（instantiateLibrary → dlopen），同步 try/catch 抓不到，
// 异常以 unhandledRejection 逃逸 → 进程层如实记 SKIP，不做为 PASS。
process.on('unhandledRejection', (e) => {
  if (hostModuleUnavailable === undefined) {
    hostModuleUnavailable = String((e as Error)?.message ?? e).split('\n')[0].slice(0, 120);
  }
});
if (hostModuleUnavailable) {
  console.log('[SKIP] 宿主 permissionEngine 模块不可加载（本机 prisma 引擎架构不匹配）：', hostModuleUnavailable);
}

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

const SECTION = (n: string) => console.log('\n' + n);

// agent test/policy.test.ts 用的同型 fixtures
function spec(over: Record<string, any> = {}) {
  return { id: 'fs.read@1.0.0', name: 'fs_read', description: 'd', inputSchema: {}, riskLevel: 'r0', sideEffects: 'none', workspaceRoots: ['/w'], ...over };
}

(async () => {
  SECTION('1. 风险定级（agent policy.test.ts 的 5 例移植）');
  check('档位下限：r0 自报 r0 保持 r0', assessRisk(spec(), { path: '/w/a.txt' }).level === 'r0');
  const esc2 = assessRisk(spec(), { path: '/w/../../etc/passwd' });
  check('路径含 .. 逃逸 → r2（规范化后落白名单外）', esc2.level === 'r2', JSON.stringify(esc2));
  check('  升档原因含穿越', esc2.reasons.some((r: string) => /穿越/.test(r)), JSON.stringify(esc2.reasons));
  const esc = assessRisk(spec(), { path: '/etc/passwd' });
  check('工作区外路径 → 升 r2', esc.level === 'r2', JSON.stringify(esc));
  check('  升档原因可审计（白名单外）', esc.reasons.some((r: string) => /白名单外/.test(r)), JSON.stringify(esc.reasons));
  const never = assessRisk(spec({ capabilityTags: ['credential_access'] }), { path: '/w/a.txt' });
  check('neverAuto 能力（credential_access）→ r3', never.level === 'r3', JSON.stringify(never));
  check('  升档原因含 neverAuto', never.reasons.some((r: string) => /neverAuto/.test(r)));
  check('非幂等副作用 → ≥ r2', assessRisk(spec({ sideEffects: 'non_idempotent' }), { path: '/w/a.txt' }).level === 'r2');
  const both = assessRisk(spec({ sideEffects: 'non_idempotent', capabilityTags: ['data_exfil'] }), { path: '/w/a.txt' });
  check('非幂等 + neverAuto → r3', both.level === 'r3', JSON.stringify(both));
  check('  升档原因含 neverAuto（先到 r3，副作用 reason 被吞——与 agent 侧同一顺序）',
    both.reasons.some((r: string) => /neverAuto/.test(r)), JSON.stringify(both.reasons));
  check('路径规范化去冗余段', normalizePath('/a/./b/../c//d') === '/a/c/d');
  check('白名单为空 → 保守拒绝（isInsideWorkspace=false）', isInsideWorkspace('/w/a', spec({ workspaceRoots: [] })) === false);

  SECTION('2. 审批状态机 DEC-02（agent policy.test.ts 的 6 例移植）');
  {
    const svc = new InMemoryApprovalService();
    const ap = svc.request({ runId: 'run1', stepId: 's1', toolId: 'fs.write@1.0.0', normalizedArgsJson: '{"path":"/w/a"}', riskLevel: 'r2', summary: '写文件' });
    check('request 后为 pending', ap.state === 'pending');
    check('同 Run 同指纹 pending 复用（防重复弹卡）', svc.request({ runId: 'run1', stepId: 's1', toolId: 'fs.write@1.0.0', normalizedArgsJson: '{"path":"/w/a"}', riskLevel: 'r2', summary: '写文件' }).id === ap.id);
    const d = svc.decide(ap.id, 'approved', 'user-1');
    check('decide approved → ok', d.ok === true);
    check('decidedBy 记录人类用户', svc.get(ap.id)?.decidedBy === 'user-1');
    check('authorize 放行', svc.authorize('run1', ap.id, 'fs.write@1.0.0', '{"path":"/w/a"}').ok === true);
    check('参数变更 → fingerprint_mismatch', svc.authorize('run1', ap.id, 'fs.write@1.0.0', '{"path":"/w/b"}').reason === 'fingerprint_mismatch');
    check('跨 Run 复用 → cross_run_reuse_denied', svc.authorize('run2', ap.id, 'fs.write@1.0.0', '{"path":"/w/a"}').reason === 'cross_run_reuse_denied');
    check('重复决定被拒', svc.decide(ap.id, 'denied', 'user-1').ok === false);
    // 单 Run 有效期到期：expireForRun 只作用于 pending 项（agent 原测法：过期后 double-decide 被拒）
    svc.expireForRun('run1');
    check('Run 终态后 double-decide 仍被拒', svc.decide(ap.id, 'denied', 'user-1').ok === false);
    check('Run 终态后 authorize 复核：已批准项仍可放行（过期只杀 pending）', svc.authorize('run1', ap.id, 'fs.write@1.0.0', '{"path":"/w/a"}').ok === true);
  }
  {
    // pending 未决定项到期 → authorize 拒（单独用例，不与上面已批准项混）
    const svc2 = new InMemoryApprovalService();
    const ap2 = svc2.request({ runId: 'runX', stepId: 's1', toolId: 'fs.write@1.0.0', normalizedArgsJson: '{"path":"/w/a"}', riskLevel: 'r2', summary: '写文件' });
    check('pending 项未到期前 authorize 拒 not_decided', svc2.authorize('runX', ap2.id, 'fs.write@1.0.0', '{"path":"/w/a"}').reason === 'not_decided');
    svc2.expireForRun('runX');
    check('Run 终态过期 → authorize 拒 state_expired', svc2.authorize('runX', ap2.id, 'fs.write@1.0.0', '{"path":"/w/a"}').reason === 'state_expired');
    check('过期项 decide 被拒', svc2.decide(ap2.id, 'approved', 'user-1').ok === false);
    check('pendingFor 不再含已过期项', svc2.pendingFor('runX').length === 0);
  }

  SECTION('3. 映射表 r0–r3 ↔ R0–R4（runbook S4 原表）');
  check('r0 → R0', RISK_LEVEL_MAP.r0 === 'R0' && agentRiskToHostRisk('r0') === 'R0');
  check('r1 → R1', RISK_LEVEL_MAP.r1 === 'R1');
  check('r2 → R2', RISK_LEVEL_MAP.r2 === 'R2');
  check('r3 → R3（**非** R4）', RISK_LEVEL_MAP.r3 === 'R3');
  check('R4 无 agent 反向档（宿主专属封顶）', hostRiskToAgentRisk('R4') === null);
  check('r2/r3 标记为必须人工', requiresHumanEachTime('r2') && requiresHumanEachTime('r3'));
  check('r0/r1 不必须人工', !requiresHumanEachTime('r0') && !requiresHumanEachTime('r1'));

  SECTION('4. 决策函数与红线（宿主 always 不得覆盖 r3）');
  if (HOST_DEFAULT_POLICY) {
    check('本地默认策略副本 == 宿主 DEFAULT_POLICY 逐项真值（防漂移守护）',
      (['R0', 'R1', 'R2', 'R3', 'R4'] as const).every((k) => DEFAULT_POLICY[k] === HOST_DEFAULT_POLICY[k]),
      `local=${JSON.stringify(DEFAULT_POLICY)} host=${JSON.stringify(HOST_DEFAULT_POLICY)}`);
  } else {
    console.log('  SKIP 宿主 DEFAULT_POLICY 逐项核对（宿主模块未给出真值：' + String(hostModuleUnavailable ?? 'null') + '）');
  }
  check('r0 + 默认策略 → allow', effectiveDecision('r0', DEFAULT_POLICY) === 'allow');
  check('r1 + 默认策略 → allow', effectiveDecision('r1', DEFAULT_POLICY) === 'allow');
  check('r2 + 默认策略(R2:confirm) → confirm', effectiveDecision('r2', DEFAULT_POLICY) === 'confirm');
  check('r3 + 默认策略 → confirm', effectiveDecision('r3', DEFAULT_POLICY) === 'confirm');
  const allAuto = { R0: 'auto', R1: 'auto', R2: 'auto', R3: 'auto', R4: 'confirm' } as const;
  check('红线1：r3 在宿主全 auto 下仍 confirm', effectiveDecision('r3', allAuto as any) === 'confirm');
  check('r2 在宿主 auto 下放行（与 r3 区别所在）', effectiveDecision('r2', allAuto as any) === 'allow');
  const alwaysPolicy = { R0: 'auto', R1: 'auto', R2: 'always', R3: 'always', R4: 'confirm' } as const;
  check('红线1：r3 在宿主全 always 下仍 confirm', effectiveDecision('r3', alwaysPolicy as any) === 'confirm');
  check('r2 在宿主 always 下 → confirm（宿主 always=confirm 别名）', effectiveDecision('r2', alwaysPolicy as any) === 'confirm');
  check('r0 在宿主 never 下 → deny', effectiveDecision('r0', { ...DEFAULT_POLICY, R0: 'never' }) === 'deny');
  check('r2 在宿主 never 下 → deny', effectiveDecision('r2', { ...DEFAULT_POLICY, R2: 'never' }) === 'deny');
  if (normalizePolicy) {
    check('宿主 normalizePolicy 仍封顶 R4', normalizePolicy({ R4: 'auto' }).R4 === 'confirm');
  } else {
    console.log('  SKIP 宿主 normalizePolicy 封顶 R4（宿主模块未给出真值：' + String(hostModuleUnavailable ?? 'null') + '）');
  }

  SECTION('5. HostApprovalService 桥接（无 DB，纯逻辑）');
  {
    const svc = new HostApprovalService({ userId: 'u1', policy: DEFAULT_POLICY, policyLoaded: true, inMemoryOnly: true });
    const ap = svc.request({ runId: 'runA', stepId: 's1', toolId: 'fs.write@1.0.0', normalizedArgsJson: '{"path":"/w/a"}', riskLevel: 'r2', summary: '写文件' });
    check('request 走通（pending）', ap.state === 'pending');
    check('describeRisk 标注宿主 R2 + 人工必须', (() => { const d = svc.describeRisk(ap.id); return d?.hostLevel === 'R2' && d.humanRequired === true; })());
    check('未决定 → authorize 拒 not_decided', svc.authorize('runA', ap.id, 'fs.write@1.0.0', '{"path":"/w/a"}').reason === 'not_decided');
    check('decide 需人类 by', svc.decide(ap.id, 'approved', 'user-1').ok === true);
    check('批准后 authorize 放行', svc.authorize('runA', ap.id, 'fs.write@1.0.0', '{"path":"/w/a"}').ok === true);
    check('跨 Run 复用仍拒（DEC-02 红线未被桥接层削弱）', svc.authorize('runB', ap.id, 'fs.write@1.0.0', '{"path":"/w/a"}').reason === 'cross_run_reuse_denied');
    check('isPolicyLoaded 如实反映策略来源', svc.isPolicyLoaded() === true);
    check('ownerUserId 透传', svc.ownerUserId() === 'u1');
  }
  {
    // 宿主策略降级为 never：authorize 复核必须覆盖已批准项（runbook：执行前复检）
    const svc = new HostApprovalService({ policy: { ...DEFAULT_POLICY, R2: 'never' }, inMemoryOnly: true });
    const ap = svc.request({ runId: 'runN', stepId: 's1', toolId: 'fs.write@1.0.0', normalizedArgsJson: '{"path":"/w/a"}', riskLevel: 'r2', summary: '写文件' });
    check('宿主 R2:never 下 describeRisk 标 deny', svc.describeRisk(ap.id)?.hostDecision === 'deny');
    check('宿主 R2:never 下 decide 仍可人工批准（不阻断人工通道）', svc.decide(ap.id, 'approved', 'user-1').ok === true);
    check('红线：宿主策略 never 在 authorize 复核时覆盖已批准 → host_policy_denied', svc.authorize('runN', ap.id, 'fs.write@1.0.0', '{"path":"/w/a"}').reason === 'host_policy_denied');
  }
  {
    // 工厂：userId 缺失 → 默认策略 + policyLoaded=false（如实标注，不伪造）
    const s2 = await createHostApprovalService(undefined, async () => DEFAULT_POLICY);
    check('无 userId → 策略标注未加载', s2.isPolicyLoaded() === false);
    // 工厂：getPolicy 抛错（本机 DB 不可用的真实路径）→ 默认策略降级
    const s3 = await createHostApprovalService('u1', async () => { throw new Error('EM_X86_64 engine mismatch'); });
    check('getPolicy 失败 → 降级默认策略且标注未加载', s3.isPolicyLoaded() === false && s3.ownerUserId() === 'u1');
    const ap = s3.request({ runId: 'runC', stepId: 's1', toolId: 'fs.write@1.0.0', normalizedArgsJson: '{"p":1}', riskLevel: 'r3', summary: 'r3 工具' });
    check('降级实例对 r3 仍走完整审批流（禁 auto-allow）', ap.state === 'pending');
  }

  console.log(`\nS4 策略与审批测试：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail > 0 ? 1 : 0;
})().catch((e) => { console.error('S4 测试崩溃:', e); process.exit(1); });
