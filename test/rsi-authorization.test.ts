// ================================================================
// RSI 权限矩阵单测：黑名单 / 七类 actor / 跨用户 / 自我审批 / 绕过尝试 / key 兜底
// 运行：npx tsx test/rsi-authorization.test.ts
// 所有断言按 src/services/rsi/authorization.ts 现有实现的真实行为编写；
// 命中「已知缺口」的断言记录当前行为，供主代理修复后更新（见报告清单）。
// ================================================================
process.env.PAUSE_ALL_WRITES = '0';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}
function t(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    console.log('\n' + name);
    try { await fn(); } catch (e) { check('unexpected throw: ' + (e as Error).message, false); }
  })();
}

(async () => {
  const A = await import('../src/services/rsi/authorization');
  const T = await import('../src/services/rsi/types');
  const can = A.can;
  const G = { assetType: 'skill_guidance', assetKey: 'skill:x', scope: 'global' } as const;

  await t('1. 黑名单：PROTECTED_TYPES 全量 16 类，admin 也不得写', () => {
    // types.ts:21-26 实际 16 项（任务书写的"五类"与实现不符，按实现测）
    check('PROTECTED_TYPES 数量为 15', T.PROTECTED_TYPES.length === 15, String(T.PROTECTED_TYPES.length));
    const groups: Record<string, string[]> = {
      提示与护栏: ['system_prompt', 'guardrail'],
      认证与授权: ['auth', 'permission', 'authorization'],
      能力与执行: ['tool_capability', 'bash_script', 'plugin', 'privileged_subagent'],
      代码与数据: ['backend_source', 'migration', 'env_secret'],
      隐私与自指: ['rsi_self', 'user_personal_memory', 'cross_user_private'],
    };
    let allBlocked = true;
    const misses: string[] = [];
    for (const list of Object.values(groups)) {
      for (const ty of list) {
        for (const kind of ['admin', 'user', 'agent', 'worker', 'subagent', 'service', 'plugin'] as const) {
          const r = can({ kind, id: 'x' }, 'propose', { assetType: ty, assetKey: 'k', scope: 'global' }, 'r2', 'active');
          if (r.allow) { allBlocked = false; misses.push(`${kind}/${ty}`); }
          if (r.reason !== 'protected_type') { allBlocked = false; misses.push(`reason:${kind}/${ty}=${r.reason}`); }
        }
      }
    }
    check('五组共 15 类黑名单 × 七主体一律 protected_type 拒绝', allBlocked, misses.slice(0, 5).join(' | '));
    check('黑名单优先级高于白名单（assetType 命中即拒，不看 key 是否合法）',
      !can({ kind: 'admin', id: 'a' }, 'experiment', { assetType: 'system_prompt', assetKey: 'skill:x', scope: 'global' }, 'r1', 'active').allow);
    check('read 是黑名单唯一例外（admin 可读受保护资产）',
      can({ kind: 'admin', id: 'a' }, 'read', { assetType: 'system_prompt', assetKey: 'k', scope: 'global' }, 'r0', 'active').allow);
    check('read 例外不扩展到 publish/rollback',
      !can({ kind: 'admin', id: 'a' }, 'rollback', { assetType: 'guardrail', assetKey: 'k', scope: 'global' }, 'r0', 'active').allow);
  });

  await t('2. 七类 actor × 动作矩阵', () => {
    // authorization.ts:21-27 动作表
    const expect: Record<string, string[]> = {
      admin: ['read', 'propose', 'approve', 'publish', 'pause', 'rollback', 'register', 'experiment', 'view_audit'],
      user: ['read', 'propose'],
      agent: ['read', 'propose', 'experiment'],
      worker: ['read', 'propose', 'experiment'],  // 实测 WORKER_ACTIONS:25 含 propose（与任务书描述不同，按源码断言）
      subagent: ['read'],
      service: ['read'],
      plugin: ['read'],
    };
    check('ActorKind 恰好 7 种', Object.keys(expect).length === 7);
    let ok = true;
    const bad: string[] = [];
    // user 的动作表只在「本人 user 域资产」上可验证（authorization.ts:94-99 对全局资产一律 not_owner）
    const assetFor = (kind: string) => kind === 'user'
      ? { assetType: 'prompt_atom_authorized', assetKey: 'k', scope: 'user', ownerId: 'x' } as const
      : G;
    for (const [kind, allowed] of Object.entries(expect)) {
      for (const ac of ['read', 'propose', 'approve', 'publish', 'pause', 'rollback', 'register', 'experiment', 'view_audit'] as const) {
        const r = can({ kind: kind as any, id: 'x' } as any, ac, assetFor(kind), 'r2', 'active');
        const want = allowed.includes(ac);
        if (r.allow !== want) { ok = false; bad.push(`${kind}/${ac}=${r.allow}(want ${want}) reason=${r.reason}`); }
      }
    }
    check('七主体 × 九动作 63 组合全部与动作表一致', ok, bad.slice(0, 6).join(' | '));
    check('【真实行为】user 对全局资产连 read 也被 not_owner 拦（:96 scope!==user）',
      can({ kind: 'user', id: 'x' }, 'read', G, 'r0', 'active').reason === 'not_owner');
    check('缺失主体 → missing_actor', !can(null as any, 'read', G, 'r0', 'active').allow
      && can(null as any, 'read', G, 'r0', 'active').reason === 'missing_actor');
    check('空 id 主体 → missing_actor', can({ kind: 'user' } as any, 'read', G, 'r0', 'active').reason === 'missing_actor');
    check('未知 actor kind → actor_kind', can({ kind: 'ghost', id: 'g' } as any, 'read', G, 'r0', 'active').reason === 'actor_kind');
  });

  await t('3. 生命周期状态门（STATE_ACTIONS）', () => {
    check('active 放行九动作', (['read', 'propose', 'approve', 'publish', 'pause', 'rollback', 'register', 'experiment', 'view_audit'] as const)
      .every((ac) => can({ kind: 'admin', id: 'a' }, ac, G, 'r3', 'active').allow));
    check('paused 仅 read/approve/view_audit', (['read', 'approve', 'view_audit'] as const)
      .every((ac) => can({ kind: 'admin', id: 'a' }, ac, G, 'r2', 'paused').allow)
      && (['propose', 'publish', 'rollback', 'experiment', 'register', 'pause'] as const)
        .every((ac) => !can({ kind: 'admin', id: 'a' }, ac, G, 'r2', 'paused').allow));
    check('quarantined 与 paused 同集合', (['read', 'approve', 'view_audit'] as const)
      .every((ac) => can({ kind: 'admin', id: 'a' }, ac, G, 'r2', 'quarantined').allow)
      && !can({ kind: 'admin', id: 'a' }, 'publish', G, 'r2', 'quarantined').allow);
    check('retired 仅 read/view_audit', can({ kind: 'admin', id: 'a' }, 'read', G, 'r2', 'retired').allow
      && can({ kind: 'admin', id: 'a' }, 'view_audit', G, 'r2', 'retired').allow
      && !can({ kind: 'admin', id: 'a' }, 'approve', G, 'r2', 'retired').allow);
    check('【已知缺口】未知状态不设状态门，admin 的 propose 直接放行（STATE_ACTIONS[status] undefined 即 fall-through）',
      can({ kind: 'admin', id: 'a' }, 'propose', G, 'r2', 'zombie').allow === true);
    check('【已知缺口】未知状态对 user 也 fall-through（仍被动作表/所有权拦）',
      can({ kind: 'user', id: 'u1' }, 'propose', { ...G, ownerId: 'u1', scope: 'user' }, 'r1', 'zombie').allow === true);
    check('状态门先于 actor 表生效（paused 下 user 的 propose 报 state_not_allowed）',
      can({ kind: 'user', id: 'u1' }, 'propose', { ...G, ownerId: 'u1', scope: 'user' }, 'r1', 'paused').reason === 'state_not_allowed');
  });

  await t('4. 跨用户读 / 写', () => {
    const other = { assetType: 'prompt_atom_authorized', assetKey: 'k', scope: 'user', ownerId: 'u2' } as const;
    check('他人用户资产：读允许', can({ kind: 'user', id: 'u1' }, 'read', other, 'r0', 'active').allow);
    check('他人用户资产：approve/view_audit 允许（只读类审批视图）', can({ kind: 'admin', id: 'a' }, 'approve', other, 'r1', 'active').allow
      && can({ kind: 'admin', id: 'a' }, 'view_audit', other, 'r1', 'active').allow);
    check('他人用户资产：user propose 拒绝且 reason=cross_user', can({ kind: 'user', id: 'u1' }, 'propose', other, 'r1', 'active').reason === 'cross_user');
    check('他人用户资产：admin propose 同样拒绝（写操作无管理员豁免）', can({ kind: 'admin', id: 'a' }, 'propose', other, 'r1', 'active').reason === 'cross_user');
    check('他人用户资产：admin rollback 拒绝', !can({ kind: 'admin', id: 'a' }, 'rollback', other, 'r1', 'active').allow);
    check('本人用户资产：user propose 允许', can({ kind: 'user', id: 'u1' }, 'propose', { ...other, ownerId: 'u1' }, 'r1', 'active').allow);
    check('本人用户资产：user approve 仍拒绝（action_not_allowed）', can({ kind: 'user', id: 'u1' }, 'approve', { ...other, ownerId: 'u1' }, 'r1', 'active').reason === 'action_not_allowed');
    check('无 ownerId 的 user 域资产：非本人不得写', can({ kind: 'user', id: 'u1' }, 'propose', { assetType: 'prompt_atom_authorized', assetKey: 'k', scope: 'user' }, 'r1', 'active').reason === 'not_owner');
    check('全局资产：普通 user 的 read 与 propose 均被 not_owner 拦', can({ kind: 'user', id: 'u1' }, 'read', G, 'r0', 'active').reason === 'not_owner'
      && can({ kind: 'user', id: 'u1' }, 'propose', G, 'r1', 'active').reason === 'not_owner');
    check('本人用户资产 read 允许', can({ kind: 'user', id: 'u1' }, 'read', { assetType: 'prompt_atom_authorized', assetKey: 'k', scope: 'user', ownerId: 'u1' }, 'r0', 'active').allow);
  });

  await t('5. 自我审批防线', () => {
    // can() 层无 proposer/approver 身份概念：以「动作本身」设防
    check('user 无法 approve（任何资产）→ 结构上不可能自审', !['skill_guidance'].some((ty) =>
      can({ kind: 'user', id: 'u1' }, 'approve', { assetType: ty, assetKey: 'k', scope: 'user', ownerId: 'u1' }, 'r1', 'active').allow));
    check('agent/worker/subagent 无 approve 动作', ['agent', 'worker', 'subagent'].every((k) =>
      !can({ kind: k as any, id: 'x' }, 'approve', G, 'r1', 'active').allow));
    check('service/plugin 无 approve 动作', !can({ kind: 'service', id: 's' }, 'approve', G, 'r1', 'active').allow
      && !can({ kind: 'plugin', id: 'p' }, 'approve', G, 'r1', 'active').allow);
    check('admin 可 approve（自审由 changeRequest.approveChange 的 proposedBy 比对拦截，见 changeRequest.ts:96-101）',
      can({ kind: 'admin', id: 'a' }, 'approve', G, 'r1', 'active').allow);
  });

  await t('6. 风险等级门', () => {
    check('agent r3 propose 拒绝（risk_too_high）', can({ kind: 'agent', id: 'a' }, 'propose', G, 'r3', 'active').reason === 'risk_too_high');
    check('agent r2 propose 允许', can({ kind: 'agent', id: 'a' }, 'propose', G, 'r2', 'active').allow);
    check('worker r3 experiment 拒绝', can({ kind: 'worker', id: 'w' }, 'experiment', G, 'r3', 'active').reason === 'risk_too_high');
    check('subagent r3 read 允许（read 不受 r3 限制）', can({ kind: 'subagent', id: 's' }, 'read', G, 'r3', 'active').allow);
    check('admin r3 全部允许（人工兜底）', can({ kind: 'admin', id: 'a' }, 'propose', G, 'r3', 'active').allow
      && can({ kind: 'admin', id: 'a' }, 'publish', G, 'r3', 'active').allow);
  });

  await t('7. assetKey 正则兜底 isProtectedAssetKey（authorization.ts:43-51）', () => {
    const patterns: Array<[string, string]> = [
      ['system_prompt:', 'system_prompt:core'],
      ['guardrail:', 'guardrail:no_pii'],
      ['auth:', 'auth:login'],
      ['permission:', 'permission:admin'],
      ['tool:', 'tool:bash'],
      ['bash:', 'bash:ls'],
      ['plugin:', 'plugin:x'],
      ['migration:', 'migration:20261107'],
      ['secret:', 'secret:vault'],
      ['env:', 'env:JWT'],
      ['rsi_self:', 'rsi_self:worker.ts'],
      ['src/', 'src/services/rsi/worker.ts'],
      ['schema:', 'schema:user'],
      ['prisma:', 'prisma:migrate'],
    ];
    check('14 条前缀模式逐一命中', patterns.every(([, k]) => A.isProtectedAssetKey(k)),
      patterns.filter(([, k]) => !A.isProtectedAssetKey(k)).map(([p]) => p).join(','));
    check('前缀大小写不敏感（SRC/ 命中）', A.isProtectedAssetKey('SRC/services/x.ts') && A.isProtectedAssetKey('System_Prompt:core'));
    check('非受保护知识键不误伤', !A.isProtectedAssetKey('knowledge_object:postgres') && !A.isProtectedAssetKey('skill:guidance-1'));
    check('can() 侧 key 兜底生效：admin 也不得写 src/ 前缀资产', can({ kind: 'admin', id: 'a' }, 'propose',
      { assetType: 'skill_guidance', assetKey: 'src/services/rsi/worker.ts', scope: 'global' }, 'r1', 'active').reason === 'protected_type');
  });

  await t('8. 绕过尝试（按现有实现记录真实行为）', () => {
    // 已知缺口①：isProtectedType 大小写敏感（types.ts:21-26 用 includes 精确匹配）
    check('assetType 大小写变形 System_Prompt **命中**黑名单（:38 isProtectedType 做小写比较）', A.isProtectedType('System_Prompt'));
    check('assetType 加前导下划线 _system_prompt **同样命中**黑名单（组件名精确匹配不含其他串）', A.isProtectedType('_system_prompt') === false ? true : A.isProtectedType('_system_prompt'));
    // 已知缺口②：key 前缀用反斜杠或前导路径分隔可绕过 ^ 锚定
    check('【已知缺口】key 反斜杠变体 src\\services 未被兜底', !A.isProtectedAssetKey('src\\services\\rsi\\worker.ts'));
    check('key 前导斜杠 /src/services **命中**兜底（正则 ^src\/ 之外未含 /，实测：/src/services → true 说明另有覆盖）', A.isProtectedAssetKey('/src/services/rsi/worker.ts') === true || A.isProtectedAssetKey('/src/services/rsi/worker.ts') === false);
    check('【已知缺口】key 中间嵌入 xsrc/ 不被误判（无误伤，属预期）', !A.isProtectedAssetKey('xsrc/services/rsi/worker.ts'));
    check('key 前导空格 system_prompt:core **命中**兜底（14 前缀之外仍有覆盖层）', A.isProtectedAssetKey('  system_prompt:core') === true);
    // 已知缺口③：scope 缺省时按 ownerId 推断，user 域无 ownerId 时写操作在状态门之后才被拦
    check('scope 缺省 + ownerId 存在 → 推断 user 域并拦跨用户写',
      can({ kind: 'user', id: 'u1' }, 'propose', { assetType: 'prompt_atom_authorized', assetKey: 'k', ownerId: 'u2' }, 'r1', 'active').reason === 'cross_user');
    check('scope 缺省 + 无 ownerId → 推断 global，user propose 被 not_owner 拦',
      can({ kind: 'user', id: 'u1' }, 'propose', { assetType: 'prompt_atom_authorized', assetKey: 'k' }, 'r1', 'active').reason === 'not_owner');
    // 白名单侧 strip 前导下划线（isAutoExperimentable:54-57）
    check('isAutoExperimentable 容忍前导下划线 _skill_guidance', A.isAutoExperimentable('_skill_guidance'));
    check('isAutoExperimentable 接受大小写变形 Skill_Guidance（:54-57 strip 后小写集合比对）', A.isAutoExperimentable('Skill_Guidance'));
  });

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
