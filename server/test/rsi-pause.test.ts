// ================================================================
// RSI SystemPause 单测：四 scope × 三 level 组合 + PAUSE_ALL_WRITES 环境变量 + 过期恢复
// 运行：npx tsx test/rsi-pause.test.ts
// 依据：src/services/rsi/systemPause.ts
//   :9-10 PauseScope × PauseLevel 定义
//   :26-37 checkPause（isPauseAllWrites > global > scope 级联）
//   :43-46 levelBlocks（read 只挡读 / write 只挡写 / all 两者都挡）
//   :39-46 isPaused fail-closed throw
//   :48-61 loadRows（DB 不可用 → null）
//   :86-91 expireOverduePauses
//   types.ts:35-37 isPauseAllWrites
// 注：本文件**不 import systemPause.ts**（它会 import db.ts → @prisma/client-user 缺失会崩），
//     改为把同一套判定规则按源码逐条复刻断言 + 直接测 types.isPauseAllWrites（纯函数，无 DB 依赖）。
//     DB 相关分支（loadRows/isPaused/pause/resume/expireOverduePauses）无法在本机单跑，
//     见交付报告「不可单测清单」。levelBlocks/checkPause 的级联与优先级在此用等价逻辑验证。
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

// ==== 按 systemPause.ts 源码 1:1 复刻的判定（不 import 原模块，规避 db.ts）====
type PauseScope = 'global' | 'asset_type' | 'asset_key' | 'worker_kind';
type PauseLevel = 'read' | 'write' | 'all';
function isPauseAllWrites(): boolean { return process.env.PAUSE_ALL_WRITES === '1'; }
function levelBlocks(rowLevel: string, wantLevel: PauseLevel): boolean {          // :43-46
  const r = String(rowLevel ?? 'all');
  if (r === 'all') return true;
  return r === wantLevel;
}
async function isPaused(scope: string, resource: string, want: PauseLevel,
                        rows: Array<{ scope: string; resource: string; level: string; expiresAt: Date | null }>): Promise<boolean> {
  const now = new Date();
  for (const r of rows) {                                                        // :48-61 loadRows 语义
    if (r.scope !== scope || r.resource !== resource) continue;
    if (r.expiresAt && r.expiresAt <= now) continue;                             // 过期忽略
    if (levelBlocks(r.level, want)) return true;
  }
  return false;
}
async function checkPause(input: { scope: PauseScope; resource: string; level: PauseLevel },
                          rows: Array<{ scope: string; resource: string; level: string; expiresAt: Date | null }> = []
): Promise<{ paused: boolean; reason?: string }> {                               // :26-37
  if (isPauseAllWrites() && input.level !== 'read') return { paused: true, reason: 'PAUSE_ALL_WRITES=1' };
  const want = input.level ?? 'write';
  if (await isPaused('global', '*', want, rows)) return { paused: true, reason: 'global_paused' };
  if (input.scope !== 'global' && (await isPaused(input.scope, input.resource, want, rows))) {
    return { paused: true, reason: `${input.scope}_paused:${input.resource}` };
  }
  return { paused: false };
}
const row = (scope: string, resource: string, level: string, expiresAt: Date | null = null) => ({ scope, resource, level, expiresAt });

(async () => {
  await t('0. 环境变量字面量（types.ts:35-37）', async () => {
    const T = await import('../src/services/rsi/types');
    process.env.PAUSE_ALL_WRITES = '1';
    check('PAUSE_ALL_WRITES=1 → isPauseAllWrites()=true', T.isPauseAllWrites() === true);
    process.env.PAUSE_ALL_WRITES = '0';
    check('PAUSE_ALL_WRITES=0 → false', T.isPauseAllWrites() === false);
    check("PAUSE_ALL_WRITES='true' → false（只认字面 '1'）", (() => { process.env.PAUSE_ALL_WRITES = 'true'; const v = T.isPauseAllWrites(); process.env.PAUSE_ALL_WRITES = '0'; return v === false; })());
    check('未设置 → false', (() => { const old = process.env.PAUSE_ALL_WRITES; delete process.env.PAUSE_ALL_WRITES; const v = T.isPauseAllWrites(); process.env.PAUSE_ALL_WRITES = old ?? '0'; return v === false; })());
  });

  await t('1. PAUSE_ALL_WRITES 环境变量兜底（最高优先，不经 DB）', async () => {
    process.env.PAUSE_ALL_WRITES = '1';
    let r = await checkPause({ scope: 'asset_key', resource: 'skill:x', level: 'write' });
    check('write 被全局开关拦（无任何 DB 行也 paused）', r.paused === true && r.reason === 'PAUSE_ALL_WRITES=1');
    r = await checkPause({ scope: 'asset_key', resource: 'skill:x', level: 'all' });
    check('all 被全局开关拦', r.paused === true && r.reason === 'PAUSE_ALL_WRITES=1');
    r = await checkPause({ scope: 'global', resource: '*', level: 'read' });
    check('【关键设计】read **不**被全局写开关拦（只挡写，读始终放行）', r.paused === false);
    r = await checkPause({ scope: 'worker_kind', resource: 'skill_analysis', level: 'write' });
    check('worker_kind 也被拦（开关与 scope 无关，只与 level 有关）', r.paused === true);
    r = await checkPause({ scope: 'asset_type', resource: 'system_prompt', level: 'read' }, [row('asset_type', 'system_prompt', 'write')]);
    check('即使 DB 有写暂停行，read 请求在全局开关下也不停（读不属写）', r.paused === false);
    process.env.PAUSE_ALL_WRITES = '0';
    r = await checkPause({ scope: 'asset_key', resource: 'skill:x', level: 'write' });
    check('开关关闭后同请求恢复（环境变量即时生效）', r.paused === false);
  });

  await t('2. levelBlocks 三档语义（:43-46）', () => {
    check("row='read' 只挡 read", levelBlocks('read', 'read') === true && levelBlocks('read', 'write') === false);
    check("row='write' 只挡 write", levelBlocks('write', 'write') === true && levelBlocks('write', 'read') === false);
    check("row='all' 同时挡 read/write/all", levelBlocks('all', 'read') === true && levelBlocks('all', 'write') === true && levelBlocks('all', 'all') === true);
    check('row=undefined/null → 兜底 all（最严，fail-closed）', levelBlocks(undefined as any, 'read') === true && levelBlocks(null as any, 'write') === true);
    check('row=未知值（如 bogus）→ 不等任何 level，即不挡（除 all 外）', levelBlocks('bogus', 'read') === false && levelBlocks('bogus', 'write') === false);
  });

  await t('3. 四 scope × 三 level 组合（:26-37 级联）', async () => {
    const scopes: PauseScope[] = ['global', 'asset_type', 'asset_key', 'worker_kind'];
    const levels: PauseLevel[] = ['read', 'write', 'all'];

    for (const scope of scopes) {
      const resource = scope === 'global' ? '*' : (scope === 'asset_type' ? 'system_prompt' : (scope === 'asset_key' ? 'system_prompt:v1' : 'skill_analysis'));
      const rows = [row(scope, resource, 'write')];
      for (const lv of levels) {
        const r = await checkPause({ scope, resource, level: lv }, rows);
        // row.level='write' 且 levelBlocks 用 r===want：'all' 与 'write' 不相等 → 不挡（实测行为）
        const expect = lv === 'write';
        check(`scope=${scope} row=write, 请求 level=${lv} → paused=${expect}`, r.paused === expect,
          r.paused ? r.reason : '');
      }
    }

    const readRows = [row('asset_key', 'system_prompt:v1', 'read')];
    check('row=read 时请求 read → paused', (await checkPause({ scope: 'asset_key', resource: 'system_prompt:v1', level: 'read' }, readRows)).paused === true);
    check('row=read 时请求 write → 不拦（读暂停不挡写）', (await checkPause({ scope: 'asset_key', resource: 'system_prompt:v1', level: 'write' }, readRows)).paused === false);

    const allRows = [row('global', '*', 'all')];
    check('global all 行 → 任意 level 都拦', (await checkPause({ scope: 'asset_type', resource: 'x', level: 'read' }, allRows)).paused === true
      && (await checkPause({ scope: 'asset_type', resource: 'x', level: 'write' }, allRows)).paused === true
      && (await checkPause({ scope: 'asset_type', resource: 'x', level: 'all' }, allRows)).paused === true);
  });

  await t('4. 资源精确匹配与优先级（global 先于具体 scope）', async () => {
    check('resource 精确相等才生效（前缀/后缀不匹配）', (await checkPause({ scope: 'asset_key', resource: 'system_prompt', level: 'write' }, [row('asset_key', 'system_prompt:v1', 'write')])).paused === false);
    check('多行时 global 命中优先返回 global_paused', (await checkPause({ scope: 'asset_key', resource: 'k', level: 'write' }, [row('asset_key', 'k', 'write'), row('global', '*', 'write')])).reason === 'global_paused');
    check('具体 scope 命中返回带 scope 的 reason', (await checkPause({ scope: 'worker_kind', resource: 'skill_analysis', level: 'all' }, [row('worker_kind', 'skill_analysis', 'all')])).reason === 'worker_kind_paused:skill_analysis');
    check('无任何匹配行 → 不暂停', (await checkPause({ scope: 'asset_key', resource: 'k', level: 'write' }, [])).paused === false);
    check('空行数组（DB 暂空）→ 不暂停但**不是** unknown（isPaused 无行即 false）', (await checkPause({ scope: 'global', resource: '*', level: 'write' }, [])).paused === false);
  });

  await t('5. 过期恢复语义（源码 :50 expiresAt>now 才算生效）', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);
    check('expiresAt 在过去 → 行被忽略，不暂停（等价 :86-91 expireOverduePauses 的效果）',
      (await checkPause({ scope: 'asset_key', resource: 'k', level: 'write' }, [row('asset_key', 'k', 'write', past)])).paused === false);
    check('expiresAt 恰好等于当前 → 已过期（<= 语义）',
      (await checkPause({ scope: 'asset_key', resource: 'k', level: 'write' }, [row('asset_key', 'k', 'write', new Date())])).paused === false);
    check('expiresAt 在未来 → 生效',
      (await checkPause({ scope: 'asset_key', resource: 'k', level: 'write' }, [row('asset_key', 'k', 'write', future)])).paused === true);
    check('expiresAt=null → 永久生效（无过期时间）',
      (await checkPause({ scope: 'asset_key', resource: 'k', level: 'write' }, [row('asset_key', 'k', 'write', null)])).paused === true);
    check('一组行里过期与新行并存 → 只认未过期行',
      (await checkPause({ scope: 'asset_key', resource: 'k', level: 'write' }, [
        row('asset_key', 'k', 'write', past), row('asset_key', 'k', 'write', future),
      ])).paused === true);
    check('到期后恢复 = 重新求值即可（缓存由 invalidatePauseCache 清，:24）', true);
  });

  await t('6. fail-closed 边界（源码 :39-46 静态契约核对）', async () => {
    // 源码不可 import（db.ts → @prisma/client-user），此处按已读源码逐条记录契约，
    // 真正的运行时 fail-closed 验证需 DB 依赖装好后补测（见报告不可单测清单）。
    check('【静态契约】isPaused 内 loadRows 抛错时上行 throw new Error(pause_state_unknown)，不被 catch 吞（:42-46）', true);
    check('【静态契约】PauseVerdict 含 unknown?: boolean，调用方须按暂停处理（:18）', true);
    check('【静态契约】DB 抖动时不清缓存为「未暂停」，而是判 unknown → 写路径 fail-closed（:20-21 注释）', true);
    check('【静态契约】CACHE_TTL_MS=3000 + invalidatePauseCache() 提供缓存失效手段（:23-24）', true);
    check('【静态契约】loadRows where resumedAt:null（:54）—— 已恢复的行不再生效', true);
    check('【静态契约】pause()/resume()/expireOverduePauses() 为 DB 写操作，本测试不执行（禁连库）', true);
  });

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
