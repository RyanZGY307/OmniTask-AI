// ================================================================
// Cloudflare 数据库绑定 — 运行时解析
// ================================================================
// 与 spec.ts 的分工：
//   spec.ts    纯函数，只判断「这是哪种绑定形式、绑定名叫什么」，不碰 IO
//   cfBinding.ts  真正去 env 里按名字取对象，并判断取到的东西**形状对不对**
//
// 三条硬规则（与 dbAdapter 整体设计一致）：
//   1. 绑定不存在 / 形状不对 → 明确返回 { ok:false, reason }，
//      **绝不静默回退**到别的连接方式（静默回退会让「以为连的是 A，
//      实际连的是 B」这类事故无声发生）。
//   2. 绝不打印绑定值。Hyperdrive 的 connectionString 含口令，
//      只放进 ConnectionSpec.normalized（该字段的契约就是「只交驱动、
//      不落日志」），展示一律走 redactSpec()。
//   3. 这里**不负责**把 PG 走 Prisma —— Prisma 无法接受任意句柄。
//      因此 Hyperdrive 返回的是解析后的 ConnectionSpec（含 normalized），
//      由既有 PG 路径消费。这是刻意不做「第二个连接池」。
//
// 重要前提（必须在部署侧成立，见 README/报告）：
//   Cloudflare 绑定只存在于 **Workers runtime** 的 env 对象。
//   普通 Node 服务（render.yaml 的 `runtime: node`）**没有 env.DB**，
//   所以本文件在 Node 下调用必然返回 ok:false —— 这不是 bug，
//   是平台语义，需要真迁到 Workers 才生效。
// ================================================================

import { parseConnection, type ConnectionSpec } from './spec';

/** D1 绑定在 env 里的最小形状（Cloudflare D1Database）。 */
export interface D1Like {
  prepare(sql: string): unknown;
  batch?(statements: unknown[]): Promise<unknown>;
  exec?(sql: string): Promise<unknown>;
}

export type CfResolveResult =
  | { ok: true; kind: 'd1'; name: string; handle: D1Like }
  | { ok: true; kind: 'hyperdrive'; name: string; pgSpec: ConnectionSpec; endpoint: { host: string; port: number | null } }
  | { ok: true; kind: 'generic'; name: string; handle: unknown; detectedAs: string }
  | { ok: false; kind: string; name: string; reason: string };

/** 判断对象是否具备 D1 的最小形状。 */
function looksLikeD1(v: unknown): v is D1Like {
  return !!v && typeof v === 'object' && typeof (v as any).prepare === 'function';
}

/** 判断对象是否具备 Hyperdrive 的最小形状。 */
function looksLikeHyperdrive(v: unknown): v is { connectionString: string; host?: string; port?: number } {
  return !!v && typeof v === 'object'
    && typeof (v as any).connectionString === 'string'
    && (v as any).connectionString.length > 0;
}

/**
 * 按绑定名从 Cloudflare env 中解析数据库句柄。
 *
 * @param spec  parseConnection 的结果，且必须是绑定形式（cfBinding 非空）
 * @param env   Cloudflare Worker 的 env 对象（生产）或等价模拟（测试）
 */
export function resolveCfBinding(spec: ConnectionSpec, env: unknown): CfResolveResult {
  const b = spec.cfBinding;
  if (!b || !b.name) {
    return { ok: false, kind: 'none', name: '', reason: '不是 Cloudflare 绑定形式（spec.cfBinding 为空）' };
  }
  const name = b.name;
  const holder = (env ?? {}) as Record<string, unknown>;
  const value = holder[name];

  if (value === undefined || value === null) {
    return {
      ok: false, kind: b.kind, name,
      reason: `Cloudflare env 中不存在绑定 ${name} —— 请确认 wrangler.toml 的 binding 名拼写一致，且当前 runtime 真能提供该绑定（Cloudflare 绑定只在 Workers runtime 存在，普通 Node 服务没有 env.${name}）`,
    };
  }

  // ---- D1 ----
  if (b.kind === 'd1') {
    if (!looksLikeD1(value)) {
      return {
        ok: false, kind: 'd1', name,
        reason: `env.${name} 不是 D1 形状（缺少 prepare 方法）；实际类型 ${Object.prototype.toString.call(value)}`,
      };
    }
    return { ok: true, kind: 'd1', name, handle: value as D1Like };
  }

  // ---- Hyperdrive ----
  if (b.kind === 'hyperdrive') {
    if (!looksLikeHyperdrive(value)) {
      return {
        ok: false, kind: 'hyperdrive', name,
        reason: `env.${name} 不是 Hyperdrive 形状（缺少 connectionString 字符串）；实际类型 ${Object.prototype.toString.call(value)}`,
      };
    }
    // connectionString 只进 normalized（交给驱动的契约字段），不进日志/投影。
    const pgSpec = parseConnection((value as any).connectionString);
    if (pgSpec.error || pgSpec.engine !== 'postgres') {
      return {
        ok: false, kind: 'hyperdrive', name,
        reason: `Hyperdrive connectionString 解析失败：${pgSpec.error ?? '引擎不是 postgres'}`,
      };
    }
    return {
      ok: true, kind: 'hyperdrive', name, pgSpec,
      endpoint: {
        host: (value as any).host ?? pgSpec.host ?? 'unknown',
        port: (value as any).port ?? pgSpec.pg?.port ?? null,
      },
    };
  }

  // ---- 泛型：探测实际形状 ----
  if (looksLikeD1(value)) {
    return { ok: true, kind: 'generic', name, handle: value, detectedAs: 'd1' };
  }
  if (looksLikeHyperdrive(value)) {
    return { ok: true, kind: 'generic', name, handle: value, detectedAs: 'hyperdrive' };
  }
  return {
    ok: false, kind: 'generic', name,
    reason: `env.${name} 既不是 D1（无 prepare）也不是 Hyperdrive（无 connectionString）；实际类型 ${Object.prototype.toString.call(value)}`,
  };
}

/**
 * 可视化能力说明（不触碰真实 env）。
 */
export function capabilityMatrix() {
  const specs: ConnectionSpec[] = [
    parseConnection('d1:CORTEX_D1'),
    parseConnection('hyperdrive:CORTEX_HYPER'),
    parseConnection('binding:CORTEX_DB'),
  ];
  return specs.map((s) => ({
    input: s.cfBinding ? `${s.cfBinding.kind}:${s.cfBinding.name}` : s.normalized,
    kind: s.cfBinding?.kind ?? 'none',
    engine: s.engine,
    authMode: s.authMode,
    needsKey: false,             // 绑定形式的全部意义：不需要 key、不需要连接串
    needsConnectionString: false,
    requiresWorkersRuntime: true, // 绑定只在 Workers runtime 存在
  }));
}
