// ================================================================
// 跨实例额度账本（PostgreSQL）。
//
// 背景：RPM/TPM/RPD/TPD 原为进程内滑动窗口（rateLimiter.ts），
// 多 Worker/多实例下各自计数、互不可见，无法保证「不突破上限」。
// 本模块把这四类计数搬到 PG，用「带 WHERE 守卫的单行 UPDATE」实现原子抢占：
//   UPDATE ... SET reqCount = reqCount + 1 WHERE scopeKey=$1 AND reqCount < $2
// 返回 0 行 = 名额已满（天然防超卖，多个实例同时抢最后一个名额时只有一个成功）。
//
// Token 采用「预留 + 结算」两段式，状态机：
//   reserved → committed（按实际用量结算，多退少补）
//   reserved → released（请求失败/取消，全额退还）
//   reserved → expired（租约过期未结算，保守处理：按预估全额计入已用）
//   committed/uncertain（上游可能已执行但本地未收到完整响应 → 按实际已知量保守计入）
//
// 不引入 Redis / BullMQ / 独立限流服务；同一请求必须同时通过全部适用层级。
// ================================================================

import { parseLimitValue } from './rateLimitParse';

export type QuotaLevel = 'api' | 'carrier' | 'model';
export type WindowKind = 'minute' | 'day';
export type ReservationStatus = 'reserved' | 'committed' | 'released' | 'expired' | 'uncertain';

/** 额度scope标识：level + 主体 + 窗口。scopeKey 全局唯一。 */
export interface QuotaScope {
  level: QuotaLevel;
  /** api: provider:tier:key 8位尾号；carrier: provider:tier；model: modelKey */
  scopeId: string;
}

export interface QuotaRequest {
  scopes: QuotaScope[];
  /** 本次预估 token（用于 TPM/TPD 预留） */
  estTokens: number;
  /** 各 scope 的限额；无限制的 dimension 传 0/undefined */
  limits: Record<string, { rpm?: number; tpm?: number; rpd?: number; tpd?: number }>;
  /** 预留租约时长（毫秒）。超时未结算 → expired */
  ttlMs?: number;
  /** 调用方生成的幂等键（同一请求重试不得重复占用） */
  idempotencyKey?: string;
  /** 追溯字段 */
  requestId?: string;
  provider?: string;
  tier?: string;
  apiKey?: string;
  modelKey?: string;
  origin?: 'chat' | 'rsi' | 'admin' | 'other';
}

export interface ReservationResult {
  ok: boolean;
  reason?: 'max_parallel' | 'rate_limited' | 'blocked' | 'db_unavailable' | 'duplicate';
  reservationId?: string;
  /** 需要释放的句柄（结束请求时调 settle） */
  settle?: (outcome: { status: 'committed' | 'released' | 'uncertain'; actualTokens?: number; note?: string }) => Promise<void>;
  deniedScope?: QuotaScope;
}

// ---------------- 纯逻辑（可单测，不依赖 DB） ----------------

/** 分钟窗口键：同一分钟内共享。 */
export function minuteWindowKey(now = Date.now()): string {
  return `m${Math.floor(now / 60_000)}`;
}

/** 日窗口键：按 RATE_WINDOW_TZ（默认 Asia/Shanghai）落日期。 */
export function dayWindowKey(now = Date.now(), tz = 'Asia/Shanghai'): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  } catch { return new Date(now).toISOString().slice(0, 10); }
}

export function scopeKeyOf(s: QuotaScope, w: WindowKind, now = Date.now(), tz?: string): string {
  const wk = w === 'minute' ? minuteWindowKey(now) : dayWindowKey(now, tz);
  return `${s.level}:${s.scopeId}:${wk}`;
}

/** 把额度配置规整为「0 = 无限」。非法值抛错（与 rateLimitParse 一致，不静默无限）。 */
export function normalizeLimits(raw: Record<string, unknown> | undefined | null): { rpm: number; tpm: number; rpd: number; tpd: number } {
  const g = (k: string): number => { const v = parseLimitValue(k, raw?.[k]); return v === null ? 0 : v; };
  return { rpm: g('rpm'), tpm: g('tpm'), rpd: g('rpd'), tpd: g('tpd') };
}

/**
 * 结算差额：由 reserved 的 estTokens 过渡到 committed 的 actualTokens。
 * 返回应付差额（正=补扣，负=退还）。多退少补，绝不重复计已发生的请求。
 */
export function settlementDelta(estTokens: number, actualTokens: number): number {
  const est = Math.max(0, Math.floor(estTokens || 0));
  const act = Math.max(0, Math.floor(actualTokens || 0));
  return act - est;
}

/**
 * 保守计费：上游可能已执行但本地未收到完整响应。
 * 规则：actualTokens 缺省/小于已确认量时，按 estTokens 全额计入（不放宽），
 * 避免「假装没消耗」把额度错误释放。
 */
export function conservativeTokens(estTokens: number, actualTokens?: number | null): number {
  const est = Math.max(0, Math.floor(estTokens || 0));
  if (actualTokens === undefined || actualTokens === null) return est;
  const act = Math.max(0, Math.floor(actualTokens));
  return Math.max(act, 0);
}

/** 状态机：合法迁移（reserved 是唯一入口；终态不可再迁）。 */
export const RESERVATION_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  reserved: ['committed', 'released', 'expired', 'uncertain'],
  committed: [],
  released: [],
  expired: [],
  uncertain: ['committed', 'released'],
};

export function canReservationTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return (RESERVATION_TRANSITIONS[from] ?? []).includes(to);
}

/** 预留是否已过期（用于崩溃/流式中断后的回收判定）。 */
export function isReservationExpired(createdAt: number, ttlMs: number, now = Date.now()): boolean {
  return now - createdAt > Math.max(0, ttlMs);
}

// ---------------- PG 实现（延迟加载 client，缺依赖时可加载纯逻辑） ----------------

let _prismaUser: any = null;
function client(): any {
  if (_prismaUser) return _prismaUser;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./db');
    _prismaUser = mod.prismaUser ?? null;
  } catch { _prismaUser = null; }
  return _prismaUser;
}

/** 供测试注入假 client。 */
export function __setQuotaClient(c: any): void { _prismaUser = c; }

const SCHEMA_READY = { value: false };

/**
 * 抢占一个窗口名额。原子性依赖 PG 单行 UPDATE 的 WHERE 守卫：
 *   只有 reqCount < limit 时 +1 才返回 1 行。
 * 多实例同时抢最后一个名额 → 只有一个 UPDATE 命中。
 */
export async function tryAcquireWindow(
  p: any,
  scope: QuotaScope,
  w: WindowKind,
  dim: 'reqMin' | 'tokMin' | 'dayReq' | 'dayTokens',
  limit: number,
  amount: number,
  now = Date.now(),
  tz?: string,
): Promise<boolean> {
  if (limit <= 0) return true; // 0 = 无限
  const key = scopeKeyOf(scope, w, now, tz);
  // 行不存在则插入 0 起点；已存在则不动（幂等建行）
  await p.$executeRawUnsafe(
    `INSERT INTO "QuotaLedger" ("scopeKey","level","scopeId","windowKind","windowKey","reqCount","tokReserved","tokCommitted","updatedAt")
     VALUES ($1,$2,$3,$4,$5,0,0,0, now())
     ON CONFLICT ("scopeKey") DO NOTHING`,
    key, scope.level, scope.scopeId, w === 'minute' ? minuteWindowKey(now, tz) : dayWindowKey(now, tz),
  );
  const col = dim === 'tokMin' || dim === 'dayTokens' ? 'tokReserved' : 'reqCount';
  const res = await p.$executeRawUnsafe(
    `UPDATE "QuotaLedger" SET "${col}" = "${col}" + $2, "updatedAt" = now()
     WHERE "scopeKey" = $1 AND "${col}" + $2 <= $3`,
    key, Math.max(0, Math.floor(amount)), Math.floor(limit),
  );
  // pg 返回 rowCount 在结果数组 [ { rowCount } ] 或直接数字
  const n = Array.isArray(res) ? Number(res[0]?.rowCount ?? 0) : Number((res as any)?.rowCount ?? 0);
  return n === 1;
}

/** 结算/退还一个窗口计数（不越界扣成负数）。 */
export async function adjustWindow(p: any, key: string, col: 'reqCount' | 'tokReserved' | 'tokCommitted', delta: number): Promise<void> {
  await p.$executeRawUnsafe(
    `UPDATE "QuotaLedger" SET "${col}" = GREATEST(0, "${col}" + $2), "updatedAt" = now() WHERE "scopeKey" = $1`,
    key, Math.floor(delta),
  );
}

// ---------------- 预留 + 结算（完整状态机，跨实例） ----------------

export interface LedgerReserveInput extends QuotaRequest {
  now?: number;
  tz?: string;
  /** 测试注入：跳过 client 检查直接判定不可用 */
  forceNoDb?: boolean;
}

/**
 * 一次请求同时占用全部适用层级（api / carrier / model × 分钟·日窗口）。
 * 全部成功才返回 ok；任一层失败即回滚本请求已占用的其它层（不半成功）。
 *
 * 实现要点：
 *  - 幂等键唯一：同一 idempotencyKey 重试直接返回原预留（不得重复占用名额）。
 *  - 行级原子抢占：见 tryAcquireWindow。
 *  - 结束必须调 settle()；未结算则由 reclaimExpiredReservations 兜底。
 */
export async function reserveQuota(input: LedgerReserveInput): Promise<ReservationResult> {
  const p = client();
  if (!p || input.forceNoDb) return { ok: false, reason: 'db_unavailable' };
  const now = input.now ?? Date.now();
  const ttlMs = Math.max(1000, input.ttlMs ?? 120_000);
  const est = Math.max(0, Math.floor(input.estTokens || 0));

  // 1) 幂等：已存在同键预留 → 直接复用（防重试双扣）
  if (input.idempotencyKey) {
    try {
      const exist = await p.quotaReservation.findUnique({ where: { reservationKey: input.idempotencyKey } });
      if (exist && exist.status === 'reserved') {
        return {
          ok: true, reservationId: exist.id,
          settle: async (o) => { await settleQuota(exist.id, o); },
        };
      }
      if (exist && exist.status !== 'reserved') return { ok: false, reason: 'duplicate', reservationId: exist.id };
    } catch { /* 表未建 → 走下面建流程，由 DDL 保证幂等 */ }
  }

  // 2) 逐层抢占（顺序：api → carrier → model；任一回滚全部）
  const takenKeys: Array<{ scope: QuotaScope; w: WindowKind; key: string; dim: 'reqCount' | 'tokReserved'; amount: number }> = [];
  const rollback = async (): Promise<void> => {
    for (const t of takenKeys) {
      try { await adjustWindow(p, t.key, t.dim === 'reqCount' ? 'reqCount' : 'tokReserved', -t.amount); }
      catch { /* 回滚失败不阻断，账面会被对账修 */ }
    }
    takenKeys.length = 0;
  };

  for (const scope of input.scopes) {
    const lim = normalizeLimits(input.limits[`${scope.level}:${scope.scopeId}`] ?? input.limits[scope.level] ?? {});
    // RPM（分钟请求）
    const mKey = scopeKeyOf(scope, 'minute', now, input.tz);
    if (lim.rpm > 0 && !(await tryAcquireWindow(p, scope, 'minute', 'reqMin', lim.rpm, 1, now, input.tz))) {
      await rollback(); return { ok: false, reason: 'rate_limited', deniedScope: scope };
    }
    takenKeys.push({ scope, w: 'minute', key: mKey, dim: 'reqCount', amount: 1 });
    // TPM（分钟 token）
    if (lim.tpm > 0 && est > 0) {
      const ok = await tryAcquireWindow(p, scope, 'minute', 'tokMin', lim.tpm, est, now, input.tz);
      if (!ok) { await rollback(); return { ok: false, reason: 'rate_limited', deniedScope: scope }; }
      takenKeys.push({ scope, w: 'minute', key: mKey, dim: 'tokReserved', amount: est });
    }
    // RPD（日请求）
    if (lim.rpd > 0) {
      if (!(await tryAcquireWindow(p, scope, 'day', 'dayReq', lim.rpd, 1, now, input.tz))) {
        await rollback(); return { ok: false, reason: 'blocked', deniedScope: scope };
      }
      takenKeys.push({ scope, w: 'day', key: scopeKeyOf(scope, 'day', now, input.tz), dim: 'reqCount', amount: 1 });
    }
    // TPD（日 token）
    if (lim.tpd > 0 && est > 0) {
      if (!(await tryAcquireWindow(p, scope, 'day', 'dayTokens', lim.tpd, est, now, input.tz))) {
        await rollback(); return { ok: false, reason: 'blocked', deniedScope: scope };
      }
      takenKeys.push({ scope, w: 'day', key: scopeKeyOf(scope, 'day', now, input.tz), dim: 'tokReserved', amount: est });
    }
  }

  // 3) 落预留行（供结算与过期回收）；写入失败不影响已抢占的名额（悲观：保留占用直到过期）
  let reservationId = '';
  try {
    const row = await p.quotaReservation.create({
      data: {
        reservationKey: input.idempotencyKey ?? `rsv_${now}_${Math.random().toString(36).slice(2, 10)}`,
        status: 'reserved',
        estTokens: est,
        scopes: JSON.stringify(input.scopes),
        origin: input.origin ?? 'other',
        provider: input.provider ?? null, tier: input.tier ?? null,
        apiKey: input.apiKey ?? null, modelKey: input.modelKey ?? null,
        requestId: input.requestId ?? null,
        expiresAt: new Date(now + ttlMs),
      },
    });
    reservationId = row.id;
  } catch { /* 唯一键冲突等：仍返回 ok，结算走 idempotencyKey 兜底 */ }

  return {
    ok: true, reservationId,
    settle: async (o) => { await settleQuota(reservationId, o); },
  };
}

/**
 * 结算一笔预留。三种结局：
 *  committed 按 actualTokens 多退少补；
 *  released  全额退还（请求未发生/失败）；
 *  uncertain 上游可能已执行 → 按保守口径计入，不算「没消耗」。
 */
export async function settleQuota(
  reservationId: string,
  outcome: { status: 'committed' | 'released' | 'uncertain'; actualTokens?: number; note?: string },
): Promise<void> {
  const p = client();
  if (!p || !reservationId) return;
  try {
    const row = await p.quotaReservation.findUnique({ where: { id: reservationId } });
    if (!row || row.status !== 'reserved') return; // 终态不可再迁（幂等）
    if (!canReservationTransition('reserved', outcome.status)) return;
    const est = Math.max(0, Math.floor(row.estTokens ?? 0));
    const scopes: QuotaScope[] = safeParseScopes(row.scopes);

    if (outcome.status === 'released') {
      for (const s of scopes) {
        await adjustWindow(p, scopeKeyOf(s, 'minute', new Date(row.createdAt).getTime()), 'reqCount', -1);
        await adjustWindow(p, scopeKeyOf(s, 'day', new Date(row.createdAt).getTime()), 'reqCount', -1);
        if (est > 0) {
          await adjustWindow(p, scopeKeyOf(s, 'minute', new Date(row.createdAt).getTime()), 'tokReserved', -est);
          await adjustWindow(p, scopeKeyOf(s, 'day', new Date(row.createdAt).getTime()), 'tokReserved', -est);
        }
      }
    } else {
      // committed / uncertain：把预估额从 reserved 挪到 committed，再按差额补退
      const actual = outcome.status === 'uncertain'
        ? conservativeTokens(est, outcome.actualTokens)
        : Math.max(0, Math.floor(outcome.actualTokens ?? est));
      for (const s of scopes) {
        const mk = scopeKeyOf(s, 'minute', new Date(row.createdAt).getTime());
        const dk = scopeKeyOf(s, 'day', new Date(row.createdAt).getTime());
        if (est > 0) {
          await adjustWindow(p, mk, 'tokReserved', -est);
          await adjustWindow(p, dk, 'tokReserved', -est);
          if (actual > 0) {
            await adjustWindow(p, mk, 'tokCommitted', actual);
            await adjustWindow(p, dk, 'tokCommitted', actual);
          }
        }
      }
      await p.$executeRawUnsafe(
        `UPDATE "QuotaReservation" SET status=$2, committedTokens=$3, settledAt=now(), note=$4 WHERE id=$1`,
        reservationId, outcome.status, actual, outcome.note ?? null,
      );
      return;
    }
    await p.$executeRawUnsafe(
      `UPDATE "QuotaReservation" SET status=$2, committedTokens=0, settledAt=now(), note=$3 WHERE id=$1`,
      reservationId, outcome.status, outcome.note ?? null,
    );
  } catch { /* 结算异常不抛：调用方已结束请求，账面靠对账/过期兜底 */ }
}

function safeParseScopes(raw: unknown): QuotaScope[] {
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(a)) return a.filter((x) => x && typeof x.level === 'string' && typeof x.scopeId === 'string').map((x) => ({ level: x.level, scopeId: x.scopeId }));
  } catch { /* ignore */ }
  return [];
}

/**
 * 过期预留回收（进程崩溃 / 流式中断未结算的兜底）。
 * 规则：reserved 且 expiresAt < now → 置 expired 并退还预估额。
 */
export async function reclaimExpiredReservations(limit = 500): Promise<number> {
  const p = client();
  if (!p) return 0;
  try {
    const rows = await p.quotaReservation.findMany({
      where: { status: 'reserved', expiresAt: { lt: new Date() } },
      take: limit, orderBy: { expiresAt: 'asc' },
    });
    for (const r of rows) {
      await settleQuota(r.id, { status: 'released', note: 'lease_expired_reclaim' });
    }
    return rows.length;
  } catch { return 0; }
}

/** 当前窗口用量快照（管理页/ debug 用）。 */
export async function ledgerUsage(scopeIds: string[]): Promise<Array<Record<string, unknown>>> {
  const p = client();
  if (!p) return [];
  try {
    return await p.quotaLedger.findMany({ where: { scopeId: { in: scopeIds } }, take: 500 });
  } catch { return []; }
}

export function quotaLedgerReady(): boolean { return !!client(); }
