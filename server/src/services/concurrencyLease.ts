// ================================================================
// 并发许可（PostgreSQL 原子事务 + Lease，跨多实例生效）。
//
// 定义：并发 = 当前正在执行的请求数（不是每分钟请求数）。
// 三级同时生效，一个请求必须同时取得所有适用层级的许可：
//   api     — 单个 API 配置下所有模型的同时请求数
//   carrier — 单个 Provider 下所有 API/模型的同时请求数
//   model   — 单个 Provider 指定模型的同时请求数
//
// 原子性：每个 leaseKey 用 pg_advisory_xact_lock(hashtext(key)) 串行化，
// 在事务内 count 未释放且未过期的 lease，未超限才插入。事务提交即放行，
// 会话级 xact 锁自动释放（与 sensitiveGuard.ts:242 同 pattern）。
// 释放：置 releasedAt（幂等，重复释放返 true）。
// 兜底：进程崩溃/机器宕机未释放 → expiresAt 过期后由 reclaimExpiredLeases 回收。
// 降级：RATE_CONCURRENCY=memory 时用进程内计数；PG 查询失败一律拒签（fail-closed）。
// ================================================================

// db 依赖延迟解析：本机缺少 node_modules/@prisma/client-user 时，
// 纯逻辑部分（key 生成、上限计算、进程内降级路径）仍可被测试直接加载。
let prismaUserRef: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  prismaUserRef = require('./db').prismaUser;
} catch {
  prismaUserRef = null;
}
const prismaUser = new Proxy({} as any, {
  get(_t, prop: string) {
    if (!prismaUserRef) throw new Error('db_unavailable');
    return prismaUserRef[prop];
  },
});
import type { ParsedRateLimitBlock } from './rateLimitParse';

export type LeaseScope = 'api' | 'carrier' | 'model';

export interface LeaseRequest {
  provider: string;
  tier: 'FREE' | 'PRO';
  apiKey: string;
  modelKey: string;
  /** 三级并发上限；null = 该级不限 */
  apiMax?: number | null;
  carrierMax?: number | null;
  modelMax?: number | null;
  /** 租约时长（毫秒）。默认 120s，覆盖"请求发出到响应结束"的全生命周期 */
  ttlMs?: number;
  /** 前缀隔离（如 'rsi:'），RSI 额度与普通额度不互相挤占 */
  keyPrefix?: string;
}

export interface LeaseHandle { scope: LeaseScope; key: string; release: () => Promise<void> }

export interface LeaseResult {
  ok: boolean;
  /** 拒绝时给出具体层级与原因，调用方据此判断是否可切换 */
  deniedScope?: LeaseScope;
  reason?: 'max_parallel' | 'concurrency_error' | 'db_unavailable';
  handles: LeaseHandle[];
}

const DEFAULT_TTL_MS = 120_000;
/** 进程内降级路径的占用计数（仅在 RATE_CONCURRENCY=memory 或 PG 不可用时使用） */
const memCounts = new Map<string, number>();

function apiKey(p: LeaseRequest): string {
  return `${p.keyPrefix ?? ''}conc:${p.provider}:${p.tier}:api:${p.apiKey}`;
}
function carrierKey(p: LeaseRequest): string {
  return `${p.keyPrefix ?? ''}conc:${p.provider}:${p.tier}:carrier`;
}
function modelKeyOf(p: LeaseRequest): string {
  return `${p.keyPrefix ?? ''}conc:${p.provider}:${p.tier}:model:${p.modelKey}`;
}
function maxOf(b: ParsedRateLimitBlock | null | undefined): number | null {
  return b ? b.maxParallel : null;
}

/** 三级并发上限 → 需要占用的 key 列表（只取有限额的级，无限级不占位）。 */
export function activeLeaseKeys(p: LeaseRequest): Array<{ scope: LeaseScope; key: string; max: number }> {
  const out: Array<{ scope: LeaseScope; key: string; max: number }> = [];
  if (p.apiMax && p.apiMax > 0) out.push({ scope: 'api', key: apiKey(p), max: p.apiMax });
  if (p.carrierMax && p.carrierMax > 0) out.push({ scope: 'carrier', key: carrierKey(p), max: p.carrierMax });
  if (p.modelMax && p.modelMax > 0) out.push({ scope: 'model', key: modelKeyOf(p), max: p.modelMax });
  return out;
}

function memAcquire(key: string, max: number): boolean {
  const cur = memCounts.get(key) ?? 0;
  if (cur >= max) return false;
  memCounts.set(key, cur + 1);
  return true;
}
function memRelease(key: string): void {
  const cur = memCounts.get(key) ?? 0;
  if (cur <= 1) memCounts.delete(key); else memCounts.set(key, cur - 1);
}

/**
 * 依次占用三级并发许可；任一被拒则回滚已占用者（含 PG 行与内存计数）。
 * 返回的 handles 由调用方在 finally 中 release。
 */
export async function acquireConcurrency(p: LeaseRequest): Promise<LeaseResult> {
  const keys = activeLeaseKeys(p);
  if (keys.length === 0) return { ok: true, handles: [] };

  const useMemory = process.env.RATE_CONCURRENCY === 'memory';
  const ttlMs = p.ttlMs && p.ttlMs > 0 ? p.ttlMs : DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);
  const holderId = `${process.pid}-${Date.now().toString(36)}`;

  // ---- 降级路径：进程内计数 ----
  if (useMemory) {
    const taken: Array<{ scope: LeaseScope; key: string }> = [];
    for (const k of keys) {
      if (memAcquire(k.key, k.max)) taken.push(k);
      else {
        for (const t of taken) memRelease(t.key);
        return { ok: false, deniedScope: k.scope, reason: 'max_parallel', handles: [] };
      }
    }
    return {
      ok: true,
      handles: taken.map((t) => ({ scope: t.scope, key: t.key, release: async () => { memRelease(t.key); } })),
    };
  }

  // ---- PG 路径：事务 + 会话级顾问锁，逐级原子占用 ----
  const acquired: Array<{ scope: LeaseScope; key: string }> = [];
  try {
    for (const k of keys) {
      // 每个 key 一个短事务：锁 → 计数 → 插入，提交即放行
      const ok = await prismaUser.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${k.key}))`;
        const rows = await tx.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM "ConcurrencyLease"
          WHERE "leaseKey" = ${k.key} AND "releasedAt" IS NULL AND "expiresAt" > now()
        `;
        const active = Number(rows[0]?.n ?? 0);
        if (active >= k.max) return false;
        await tx.concurrencyLease.create({
          data: { leaseKey: k.key, holderId, tier: p.tier, scope: k.scope, acquiredAt: new Date(), expiresAt },
        });
        return true;
      }, { timeout: 5000 });
      if (!ok) {
        for (const a of acquired) await releaseLease(a.key).catch(() => undefined);
        return { ok: false, deniedScope: k.scope, reason: 'max_parallel', handles: [] };
      }
      acquired.push({ scope: k.scope, key: k.key });
    }
  } catch (e) {
    // PG 抖动：回滚已占用 + fail-closed 拒签（不静默放行）
    for (const a of acquired) await releaseLease(a.key).catch(() => undefined);
    return { ok: false, reason: 'db_unavailable', handles: [] };
  }

  return {
    ok: true,
    handles: acquired.map((a) => ({ scope: a.scope, key: a.key, release: async () => { await releaseLease(a.key); } })),
  };
}

/** 幂等释放：已释放的行不影响结果（UPDATE 命中 0 行也返 true）。 */
export async function releaseLease(key: string): Promise<boolean> {
  if (process.env.RATE_CONCURRENCY === 'memory') { memRelease(key); return true; }
  try {
    const r = await prismaUser.concurrencyLease.updateMany({
      where: { leaseKey: key, releasedAt: null },
      data: { releasedAt: new Date() },
    });
    return true; // count=0 表示已释放过，同样视为成功
  } catch {
    return false;
  }
}

/** 过期回收：进程崩溃后未释放的 lease 到期即失效。返回回收条数。 */
export async function reclaimExpiredLeases(): Promise<number> {
  if (process.env.RATE_CONCURRENCY === 'memory') return 0;
  try {
    const r = await prismaUser.concurrencyLease.updateMany({
      where: { releasedAt: null, expiresAt: { lt: new Date() } },
      data: { releasedAt: new Date() },
    });
    return r.count;
  } catch {
    return 0;
  }
}

/**
 * 当前活跃租约数（数字）。keyPrefix 为空 = 全部。
 * 供删除配置前判断「是否仍有活动占用」：有则不删，避免旧记录失去关联。
 */
export async function countActiveLeases(keyPrefix = ''): Promise<number> {
  try {
    const rows = await prismaUser.concurrencyLease.findMany({
      where: { leaseKey: { startsWith: `${keyPrefix}conc:` }, releasedAt: null, expiresAt: { gt: new Date() } },
      select: { leaseKey: true },
    });
    return rows.length;
  } catch { return 0; }
}

/** 按 key 分组的活跃租约数（admin 面板展示）。 */
export async function activeLeaseCount(keyPrefix = ''): Promise<Record<string, number>> {
  try {
    const rows = await prismaUser.concurrencyLease.findMany({
      where: { leaseKey: { startsWith: `${keyPrefix}conc:` }, releasedAt: null, expiresAt: { gt: new Date() } },
      select: { leaseKey: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.leaseKey] = (out[r.leaseKey] ?? 0) + 1;
    return out;
  } catch {
    return {};
  }
}

export { maxOf };
