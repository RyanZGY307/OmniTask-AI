// ================================================================
// Cloudflare 数据库绑定 — 解析 + 运行时探测测试
// Run: npx tsx test/cloudflareBinding.test.ts
//
// 用户要求：「不需要 API 密钥或连接字符串，也可以通过 Cloudflare
// 数据库连接绑定来访问」。
//
// 这里分两层验证，避免只测字符串解析就宣称「已支持」：
//   A-E 解析层：纯函数，各种绑定形式、错误形式、与既有形式的冲突优先级
//   F-G  探测层：resolveCfBinding() 在**真的** Cloudflare 形状的 env 上
//               能否取出可用句柄（本地模拟 D1 / Hyperdrive 对象）
// ================================================================

import {
  parseConnection, redactSpec, requiresApiKey, describeSpec,
  type ConnectionSpec,
} from '../src/services/dbAdapter/spec';
import { resolveCfBinding } from '../src/services/dbAdapter/cfBinding';

void (async () => {

  let pass = 0, fail = 0;
  const check = (n: string, c: boolean, d = '') =>
    c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, d));
  const S = (n: string) => console.log('\n=== ' + n + ' ===');

  // ================= A. 三种绑定形式 =================
  S('A. 绑定形式解析（D1 / Hyperdrive / 泛型）');
  {
    const d1 = parseConnection('d1:CORTEX_D1');
    check('d1:CORTEX_D1 → engine=sqlite', d1.engine === 'sqlite', d1.engine);
    check('d1 → authMode=none（无需 key）', d1.authMode === 'none', d1.authMode);
    check('d1 → cfBinding.kind=d1', d1.cfBinding?.kind === 'd1');
    check('d1 → cfBinding.name=CORTEX_D1', d1.cfBinding?.name === 'CORTEX_D1', d1.cfBinding?.name);
    check('d1 → 不要求 API key', requiresApiKey(d1) === false);

    const hd = parseConnection('hyperdrive:CORTEX_HYPER');
    check('hyperdrive → engine=postgres', hd.engine === 'postgres', hd.engine);
    check('hyperdrive → kind=hyperdrive', hd.cfBinding?.kind === 'hyperdrive');
    check('hyperdrive → authMode=none', hd.authMode === 'none');
    check('hyperdrive → host 标记为 cloudflare-hyperdrive', hd.host === 'cloudflare-hyperdrive', hd.host ?? 'null');

    const g = parseConnection('binding:CORTEX_DB');
    check('binding: → kind=generic', g.cfBinding?.kind === 'generic', g.cfBinding?.kind);
    check('generic → engine=unknown（待运行时探测）', g.engine === 'unknown', g.engine);

    // 同义前缀
    for (const v of ['cf-d1:DB', 'cf_d1:DB', 'cfbinding:DB', 'cf-binding:DB',
                     'cloudflare-binding:DB', 'bind:DB']) {
      const p = parseConnection(v);
      check(`同义前缀 ${v} 识别为绑定（kind=${p.cfBinding?.kind ?? 'none'}）`,
        p.cfBinding?.name === 'DB' && p.error === null,
        `kind=${p.cfBinding?.kind} error=${p.error}`);
    }
  }

  // ================= B. 绑定名的错误处理 =================
  S('B. 绑定名非法/为空必须报错（不能静默通过）');
  {
    const empty = parseConnection('d1:');
    check('d1: 空名 → error 且 cfBinding.name 为空串',
      empty.error !== null && empty.cfBinding?.name === '', String(empty.error));
    check('空名 → engine=unknown（不会假装成 sqlite）', empty.engine === 'unknown', empty.engine);
    check('空名不要求 API key（问题是缺绑定名，不是缺 key）', requiresApiKey(empty) === false);

    for (const bad of ['d1:CORTEX-D1', 'd1:CORTEX.D1', 'd1:1DB', 'd1:CORTEX/D1', 'd1:DB;drop']) {
      const p = parseConnection(bad);
      check(`${bad} → 判为非法绑定名`,
        p.error !== null && p.cfBinding?.kind === 'd1', String(p.error));
    }
    // 合法但不常见的名字应通过
    for (const ok of ['d1:_DB', 'd1:$DB', 'd1:DB2', 'd1:a_b_9']) {
      check(`${ok} → 合法`, parseConnection(ok).error === null, String(parseConnection(ok).error));
    }
  }

  // ================= C. 与既有形式不冲突 =================
  S('C. 优先级：绑定形式不能抢走原有的连接串/路径');
  {
    // 这是本次实现的关键风险点：绑定分支若提前，会把下面这些误判成绑定
    const pg = parseConnection('postgres://u:p@h:5432/db?sslmode=require');
    check('postgres:// 仍是 postgres（未被抢走）', pg.engine === 'postgres' && pg.cfBinding === null,
      `engine=${pg.engine} cf=${JSON.stringify(pg.cfBinding)}`);

    const file = parseConnection('file:/abs/path/db.sqlite');
    check('file:/path 仍是 sqlite 文件', file.engine === 'sqlite' && file.filePath === '/abs/path/db.sqlite'
      && file.cfBinding === null, `fp=${file.filePath} cf=${JSON.stringify(file.cfBinding)}`);

    const rel = parseConnection('./data/cortex.sqlite');
    check('相对路径仍是 sqlite 文件', rel.engine === 'sqlite' && rel.cfBinding === null);

    const lib = parseConnection('libsql://h/db?authToken=t');
    check('libsql:// 仍是 libsql', lib.engine === 'libsql' && lib.cfBinding === null);

    const api = parseConnection('api-key:sk_123&endpoint=postgres://h/db');
    check('api-key:+endpoint 仍是 api-key 形式', api.authMode === 'api-key' && api.cfBinding === null);

    // 反向：以 "binding" 开头的**路径**不应变成绑定（路径规则在前）
    const weird = parseConnection('bindings.db');
    check('bindings.db 文件不误判为 binding:', weird.cfBinding === null,
      JSON.stringify(weird.cfBinding));
  }

  // ================= D. 脱敏投影 =================
  S('D. redactSpec 不泄露凭据，但保留绑定名');
  {
    const r = redactSpec(parseConnection('d1:CORTEX_D1'));
    check('投影含 cfBinding.kind', r.cfBinding && (r.cfBinding as any).kind === 'd1');
    check('投影含 cfBinding.name（不含凭据，可展示）',
      r.cfBinding && (r.cfBinding as any).name === 'CORTEX_D1');
    check('投影不含 apiKey', !('apiKey' in r));
    check('投影不含 normalized', !('normalized' in r));
    // D1/Hyperdrive 形式本身不含密钥，但若有人把密钥塞进绑定名后面的 query，
    // 也不得出现在投影里
    const withKey = redactSpec(parseConnection('d1:DB?token=SECRET_XYZ'));
    check('带 ?token= 的绑定不泄露 token',
      JSON.stringify(withKey).indexOf('SECRET_XYZ') === -1, JSON.stringify(withKey));
    check('且绑定名未把 query 带进去', (withKey.cfBinding as any)?.name === 'DB',
      String((withKey.cfBinding as any)?.name));
    const dk = redactSpec(parseConnection('binding:MY_DB'));
    check('泛型绑定投影正常', (dk.cfBinding as any)?.name === 'MY_DB');
  }

  // ================= E. describeSpec 人类可读 =================
  S('E. describeSpec 给出可读描述');
  {
    const desc = describeSpec(parseConnection('d1:CORTEX_D1'));
    check('描述含绑定名 CORTEX_D1', desc.includes('CORTEX_D1'), desc);
    check('描述含 D1', /d1/i.test(desc), desc);
    const hd = describeSpec(parseConnection('hyperdrive:CORTEX_HYPER'));
    check('Hyperdrive 描述含 Hyperdrive', /hyperdrive/i.test(hd) && hd.includes('CORTEX_HYPER'), hd);
    // 错误形式也要有描述（admin 页要显示）
    const bad = describeSpec(parseConnection('d1:'));
    check('错误形式有描述', bad.length > 0 && bad !== 'unknown', bad);
  }

  // ================= F. 运行时解析（D1 形状） =================
  S('F. resolveCfBinding 在真实 Cloudflare 形状的 env 上取 D1');
  {
    // 模拟 Cloudflare Worker 的 env：D1 绑定是带 prepare() 的对象
    const calls: string[] = [];
    const env = {
      CORTEX_D1: {
        prepare: (sql: string) => {
          calls.push(sql);
          return {
            bind: () => ({ first: async () => ({ ok: 1 }), all: async () => ({ results: [] }) }),
            first: async () => ({ ok: 1 }),
            all: async () => ({ results: [] }),
          };
        },
        batch: async () => [],
        exec: async () => {},
      },
    };
    const spec = parseConnection('d1:CORTEX_D1');
    const r = resolveCfBinding(spec, env as any);
    check('解析成功且 kind=d1', r.ok && r.kind === 'd1', r.ok ? '' : r.reason);
    check('返回的 handle 有 prepare（D1Database 形状）', r.ok && typeof (r.handle as any).prepare === 'function');
    if (r.ok && typeof (r.handle as any).prepare === 'function') {
      const out = await (r.handle as any).prepare('SELECT 1 as ok').first();
      check('真能通过句柄执行一次 prepare().first()', out?.ok === 1, JSON.stringify(out));
    }
    check('未把任何 key 写进结果', JSON.stringify(r).indexOf('token') === -1);
  }

  // ================= G. 运行时解析（Hyperdrive 与缺失） =================
  S('G. resolveCfBinding 对 Hyperdrive / 缺失绑定的行为');
  {
    const env = {
      CORTEX_HYPER: {
        connectionString: 'postgres://user:pw@db.example.com:5432/cortex?sslmode=require',
        host: 'db.example.com', port: 5432,
      },
    };
    const spec = parseConnection('hyperdrive:CORTEX_HYPER');
    const r = resolveCfBinding(spec, env as any);
    check('Hyperdrive 解析成功', r.ok && r.kind === 'hyperdrive', r.ok ? '' : r.reason);
    const pgSpec = r.ok ? r.pgSpec : null;
    check('得到真正的 PG 连接串（供 Prisma 用）',
      !!pgSpec && pgSpec.engine === 'postgres',
      pgSpec ? `engine=${pgSpec.engine}` : '无 pgSpec');
    check('PG spec 解析出数据库名 cortex', pgSpec?.target === 'cortex', String(pgSpec?.target));
    check('PG spec 标记 ssl', pgSpec?.pg?.ssl === true, String(pgSpec?.pg?.ssl));
    // 连接串本身必须留在 spec.normalized（仅交给驱动），不得出现在任何投影里
    check('连接串不出现在脱敏投影',
      JSON.stringify(redactSpec(pgSpec!)).indexOf('pw') === -1,
      JSON.stringify(redactSpec(pgSpec!)));

    // 绑定不存在 → 明确失败，绝不静默回退
    const missing = resolveCfBinding(parseConnection('d1:NOPE'), {} as any);
    check('env 里没有该绑定 → ok=false', missing.ok === false);
    check('失败原因含绑定名 NOPE', !missing.ok && missing.reason.includes('NOPE'),
      missing.ok ? '' : missing.reason);
    check('失败不伪装成已连接', !missing.ok && !('handle' in missing) || !missing.handle);

    // 绑定存在但形状不对（误把字符串当绑定）
    const wrong = resolveCfBinding(parseConnection('d1:STR'), { STR: 'postgres://x/y' } as any);
    check('env[name] 不是 D1 形状 → ok=false 且说明原因',
      wrong.ok === false && /D1|prepare/i.test(wrong.reason),
      wrong.ok ? '未失败' : wrong.reason);

    // 非绑定 spec 不该走这条路
    const notBinding = resolveCfBinding(parseConnection('postgres://u:p@h/db'), env as any);
    check('普通 postgres spec → ok=false（不应走绑定路径）',
      notBinding.ok === false && !notBinding.ok, notBinding.ok ? '竟然 ok' : notBinding.reason);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
})();
