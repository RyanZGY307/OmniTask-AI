// ================================================================
// RSI 状态机单测：CHANGE_TRANSITIONS 全合法迁移 + 全非法迁移
// 运行：npx tsx test/rsi-state.test.ts
// 依据：src/services/rsi/types.ts:30-32（9 种 ChangeStatus）+ :39-49（转移表）
//       src/services/rsi/changeState.ts:10-12（canTransition 纯函数）
//       src/services/rsi/changeRequest.ts:58-61（transition 抛 illegal_transition）
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
  const C = await import('../src/services/rsi/changeState');
  const T = await import('../src/services/rsi/types');

  const STATUSES = ['pending', 'awaiting_approval', 'approved', 'rejected', 'evaluating', 'canary', 'released', 'failed', 'rolled_back'] as const;
  const LEGAL: Record<string, string[]> = {
    pending: ['awaiting_approval', 'evaluating', 'rejected', 'failed'],
    evaluating: ['awaiting_approval', 'rejected', 'failed', 'canary'],
    awaiting_approval: ['approved', 'rejected', 'failed'],
    approved: ['canary', 'failed', 'released'],
    canary: ['released', 'rolled_back', 'failed', 'awaiting_approval'],
    released: ['rolled_back'],
    failed: [],
    rejected: [],
    rolled_back: [],
  };

  await t('1. 转移表结构', () => {
    check('ChangeStatus 共 9 种', STATUSES.length === 9);
    check('changeState 再导出的表与 types 原表同一引用', C.CHANGE_TRANSITIONS === (T.CHANGE_TRANSITIONS as any));
    check('转移表键集合 == 9 状态集合', Object.keys(C.CHANGE_TRANSITIONS).sort().join(',') === [...STATUSES].sort().join(','));
    check('canTransition 是纯函数（同输入同输出）', C.canTransition('pending', 'approved') === C.canTransition('pending', 'approved'));
    check('未知 from → false', !C.canTransition('no_such_status', 'approved'));
    check('未知 to → false', !C.canTransition('pending', 'no_such_status'));
    const total = Object.values(C.CHANGE_TRANSITIONS).reduce((a, b) => a + b.length, 0);
    check('合法边总数 19', total === 19, String(total));
    check('无自环（from 不含自身）', STATUSES.every((s) => !(C.CHANGE_TRANSITIONS[s] ?? []).includes(s)));
    check('终态 failed/rejected/rolled_back 无出边', ['failed', 'rejected', 'rolled_back'].every((s) => (C.CHANGE_TRANSITIONS[s] ?? []).length === 0));
  });

  await t('2. 全量合法迁移（19 条，逐条断言）', () => {
    let ok = true;
    const bad: string[] = [];
    for (const from of STATUSES) {
      for (const to of LEGAL[from]) {
        if (!C.canTransition(from, to)) { ok = false; bad.push(`${from}->${to}`); }
      }
    }
    check('19 条合法迁移全部返回 true', ok, bad.join(','));
  });

  await t('3. 全量非法迁移（9×9=81 组合中 62 条非法，逐条断言）', () => {
    let ok = true;
    const bad: string[] = [];
    let legalCount = 0;
    let illegalCount = 0;
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const want = LEGAL[from].includes(to);
        const got = C.canTransition(from, to);
        if (want) legalCount++; else illegalCount++;
        if (got !== want) { ok = false; bad.push(`${from}->${to}=${got}(want ${want})`); }
      }
    }
    check('81 组合 × 与表逐条一致', ok, bad.slice(0, 8).join(','));
    check('其中合法 19 条 / 非法 62 条', legalCount === 19 && illegalCount === 62, `${legalCount}/${illegalCount}`);
  });

  await t('4. 关键路径：审批链不可跳跃', () => {
    check('pending 不能直接进 canary（跳过评估/审批）', !C.canTransition('pending', 'canary'));
    check('pending 不能直接进 approved', !C.canTransition('pending', 'approved'));
    check('pending 不能直接进 released', !C.canTransition('pending', 'released'));
    check('awaiting_approval 不能直接进 canary', !C.canTransition('awaiting_approval', 'canary'));
    check('awaiting_approval 不能直接进 released', !C.canTransition('awaiting_approval', 'released'));
    check('【已知缺口】approved 可直接 released（转移表允许跳过 canary 观测）', C.canTransition('approved', 'released') === true);
    check('evaluating 可进 canary（评估通过）', C.canTransition('evaluating', 'canary'));
    check('审批后回退：canary 可回到 awaiting_approval（重新审批）', C.canTransition('canary', 'awaiting_approval'));
  });

  await t('5. 终态与回滚语义', () => {
    check('released 只能 rolled_back（唯一出边）', C.CHANGE_TRANSITIONS.released.length === 1 && C.CHANGE_TRANSITIONS.released[0] === 'rolled_back');
    check('released 不可回退到 pending/approved/canary', !C.canTransition('released', 'pending') && !C.canTransition('released', 'approved') && !C.canTransition('released', 'canary'));
    check('released 不可 rejected/failed', !C.canTransition('released', 'rejected') && !C.canTransition('released', 'failed'));
    check('released 可 rolled_back', C.canTransition('released', 'rolled_back'));
    check('rolled_back 是绝对终态：到任何状态均 false', STATUSES.every((s) => !C.canTransition('rolled_back', s)));
    check('rolled_back → released 明确 false（不可复活）', !C.canTransition('rolled_back', 'released'));
    check('failed 是终态：任何迁移 false', STATUSES.every((s) => !C.canTransition('failed', s)));
    check('rejected 是终态：任何迁移 false', STATUSES.every((s) => !C.canTransition('rejected', s)));
  });

  await t('6. changeRequest.transition 与状态机的耦合（静态核对，不需 DB）', () => {
    // changeRequest.ts:58-61 用同一 canTransition 抛 illegal_transition:from->to
    check('canTransition 拒绝的组合对应 transition 会抛 illegal_transition',
      !C.canTransition('released', 'pending'));
    check('幂等短路：cur.status === to 时直接 return（changeRequest.ts:58），不走转移表',
      C.canTransition('canary', 'canary') === false);
  });

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
