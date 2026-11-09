// ================================================================
// Rate Limiter — 三类独立额度的滑动窗口限流。
//
// 三个作用域各自独立配置（均可在 admin「/admin/models」手填，留空/-=无限）：
//   1) 单 API 限制  apiLimit     — 每把 API key 独立额度
//   2) 运营商限制   carrierLimit — 同一供应商下所有 key 统一额度
//   3) 调用模型限制 modelLimit   — 每个模型独立额度
//
// 每个作用域支持：RPM / TPM / RPD / 最大并行 / TPD。
// TPD 到达后两种行为：
//   - block     当日不可用（请求直接拒绝，触发轮询切到下一个 key/供应商）
//   - limitRpm  将当日 RPM 降到 tpdLimitRpm 继续放行（限流降级）
//
// 额度窗口时区：RATE_WINDOW_TZ（默认 Asia/Shanghai），未设时保持 UTC 兼容旧行为。
// 并发占用在 RATE_CONCURRENCY=pg 时走 ConcurrencyLease（跨实例，见 concurrencyLease.ts）。
// 额度字段统一走 rateLimitParse.parseLimitValue：'-'/空=无限制，非法值抛错而非静默无限。
// 用于「多供应商/API 轮询」时的选择与拒绝判断，防止单一 key 额度用尽
// 直接报错——到达限制的作用域会被跳过，自动切到下一个可用作用域。
// ================================================================

import { parseLimitValue } from './rateLimitParse';
import { acquireConcurrency, releaseLease, activeLeaseKeys, type LeaseRequest } from './concurrencyLease';

export type TpdBehavior = 'block' | 'limitRpm';

/** 一个作用域的限额配置。所有字段可选；缺失/0/- 一律视为无限。 */
export interface RateLimitBlock {
  rpm?: number;
  tpm?: number;
  rpd?: number;
  maxParallel?: number;
  tpd?: number;
  tpdBehavior?: TpdBehavior;
  tpdLimitRpm?: number;
}

export interface AcquireInput {
  /** 该作用域的限额（undefined = 该作用域不限） */
  limit: RateLimitBlock;
  /** 预估本次请求消耗的 token（默认 0） */
  estTokens?: number;
}

export interface AcquireResult {
  allowed: boolean;
  /** 拒绝/限流原因（限流时给出实际生效的 RPM，便于调用方排队） */
  reason?: 'blocked' | 'tpd_limit_rpm' | 'rate_limited';
  effectiveRpm?: number;
}

interface WindowState {
  // 每分钟请求窗口（用于 RPM）
  reqMin: { minuteKey: string; count: number };
  // 当日请求（RPD / RPD 降级）
  dayKey: string;
  dayReq: number;
  dayTokens: number;
  // 每分钟 token（TPM）
  tokMin: { minuteKey: string; count: number };
  // 并行占用
  parallel: number;
}

const WINDOW_TZ = (process.env.RATE_WINDOW_TZ || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
/** 按配置时区取日期键；时区不可用时回退 UTC（不抛错，限流不能因配置错误整体停摆）。 */
export function windowTz(): string { return WINDOW_TZ; }
function dayKeyIn(now: number): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: WINDOW_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
    return parts; // YYYY-MM-DD
  } catch { return new Date(now).toISOString().slice(0, 10); }
}
/** 次日零点的毫秒数（按配置时区）。 */
/** 目标时区相对 UTC 的偏移毫秒（按给定时刻计算，兼容 Intl 支持的全部时区）。 */
function tzOffsetMs(now: number): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: WINDOW_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const parts = dtf.formatToParts(new Date(now));
    const pick = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
    const wall = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
    return wall - now;
  } catch { return 0; }
}
/** 距「配置时区」次日零点的毫秒数（用于排队提示与 RPD/TPD 重置提示）。 */
export function msUntilNextWindowDay(now = Date.now()): number {
  try {
    const local = now + tzOffsetMs(now);
    const d = new Date(local);
    d.setUTCHours(24, 0, 0, 0);
    return Math.max(1000, d.getTime() - local);
  } catch {
    const dt = new Date(now); dt.setUTCHours(24, 0, 0, 0);
    return Math.max(1000, dt.getTime() - now);
  }
}
function minuteKey(now = Date.now()): string {
  return String(Math.floor(now / 60_000));
}

/**
 * 内部口径：null / '-' / 空 → 0（=无限）；正整数 → 生效额度。
 * 非法值（负数/小数/非数字字符串）抛错，绝不静默变成 0=无限。
 */
function norm(field: string, v: unknown): number {
  const parsed = parseLimitValue(field, v);
  return parsed === null ? 0 : parsed;
}

/**
 * 检查单个作用域。`state` 由调用方持有（每个作用域一个 WindowState）。
 * 返回是否放行 + 实际生效的 RPM（若 TPD 已到达且行为为 limitRpm，则 RPM 被封顶）。
 * 会就地累计本次请求的消耗（请求数 + token + 并行 +1），调用方在请求结束后
 * 调 release(state) 释放并行占用。
 */
export function tryAcquire(state: WindowState, input: AcquireInput): AcquireResult {
  const limit = input.limit;
  if (!limit) return { allowed: true };
  const estTokens = Math.max(0, input.estTokens || 0);
  const now = Date.now();
  const mk = minuteKey(now);
  const dk = dayKeyIn(now);

  // 惰性滚日 / 滚分钟
  if (state.dayKey !== dk) {
    state.dayKey = dk;
    state.dayReq = 0;
    state.dayTokens = 0;
  }
  if (state.reqMin.minuteKey !== mk) {
    state.reqMin = { minuteKey: mk, count: 0 };
  }
  if (state.tokMin.minuteKey !== mk) {
    state.tokMin = { minuteKey: mk, count: 0 };
  }

  const rpm = norm('rpm', limit.rpm);
  const tpm = norm('tpm', limit.tpm);
  const rpd = norm('rpd', limit.rpd);
  const maxParallel = norm('maxParallel', limit.maxParallel);
  const tpd = norm('tpd', limit.tpd);
  const behavior: TpdBehavior = limit.tpdBehavior === 'limitRpm' ? 'limitRpm' : 'block';
  const tpdLimitRpm = norm('tpdLimitRpm', limit.tpdLimitRpm);

  // ---- TPD 到达判定 ----
  const tpdReached = tpd > 0 && state.dayTokens >= tpd;
  if (tpdReached && behavior === 'block') {
    // 当日 token 用尽且行为=不可用 → 直接拒绝
    return { allowed: false, reason: 'blocked' };
  }

  // TPD 到达且行为=限制RPM：把 RPM 封顶到 tpdLimitRpm（若填了）
  let effectiveRpm = rpm;
  if (tpdReached && behavior === 'limitRpm' && tpdLimitRpm > 0) {
    effectiveRpm = tpdLimitRpm;
  }

  // ---- 各维度校验 ----
  // 并行（并发满 = 排队等待，**不得**触发自动切换 → 专用 reason）
  if (maxParallel > 0 && state.parallel >= maxParallel) {
    return { allowed: false, reason: 'max_parallel', effectiveRpm };
  }
  // RPM
  if (effectiveRpm > 0 && state.reqMin.count >= effectiveRpm) {
    return { allowed: false, reason: 'rate_limited', effectiveRpm };
  }
  // RPD
  if (rpd > 0 && state.dayReq >= rpd) {
    return { allowed: false, reason: 'blocked' };
  }
  // TPM
  if (tpm > 0 && state.tokMin.count + estTokens > tpm) {
    return { allowed: false, reason: 'rate_limited', effectiveRpm };
  }
  // TPD（预判：若本次会超过当日 token 且行为=block）
  if (tpd > 0 && behavior === 'block' && state.dayTokens + estTokens > tpd && state.dayTokens > 0) {
    // 仅当已消耗过才拦；estTokens 超限时保守放行以免误伤（下一轮 dayTokens 会记录）
  }

  // ---- 累计（原子占用） ----
  state.reqMin.count += 1;
  state.dayReq += 1;
  state.dayTokens += estTokens;
  state.tokMin.count += estTokens;
  state.parallel += 1;

  return { allowed: true, effectiveRpm };
}

/** 释放一次并行占用（请求结束/失败时调用）。 */
export function release(state: WindowState): void {
  if (state.parallel > 0) state.parallel -= 1;
}

// ==================== 负载状态判定（前端展示 + 排队决策） ====================

export type LoadLevel = 'ok' | 'hot' | 'busy' | 'blocked';

function normNum(v: number | undefined | null): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// （窗口重置等待改用时区版 msUntilNextWindowDay）

/**
 * 判定单个作用域的负载等级：
 *   blocked  暂不可用（当日 TPD 用尽且行为=不可用，或当日 RPD 用尽）
 *   busy     需排队（当前分钟 RPM/TPM/并行已饱和，或当日 RPD/TPD 到限）
 *   hot      调用量高（接近限额 ≥80%）
 *   ok       正常
 */
export function statusOf(state: WindowState, limit: RateLimitBlock | undefined | null): LoadLevel {
  if (!limit) return 'ok';
  const rpm = normNum(limit.rpm);
  const tpm = normNum(limit.tpm);
  const rpd = normNum(limit.rpd);
  const par = normNum(limit.maxParallel);
  const tpd = normNum(limit.tpd);
  const behavior: TpdBehavior = limit.tpdBehavior === 'limitRpm' ? 'limitRpm' : 'block';

  // 当日维度
  if (rpd > 0 && state.dayReq >= rpd) return 'blocked';
  if (tpd > 0 && state.dayTokens >= tpd && behavior === 'block') return 'blocked';
  if (tpd > 0 && state.dayTokens >= tpd) return 'busy'; // limitRpm 模式下仍可用但受限

  // 当前分钟维度
  if (par > 0 && state.parallel >= par) return 'blocked'; // 并发满：排队而非降级
  const mBusy =
    (rpm > 0 && state.reqMin.count >= rpm) ||
    (tpm > 0 && state.tokMin.count >= tpm);
  if (mBusy) return 'busy';

  // 接近限额（≥80%）
  const mHot =
    (rpm > 0 && state.reqMin.count >= 0.8 * rpm) ||
    (tpm > 0 && state.tokMin.count >= 0.8 * tpm) ||
    (par > 0 && state.parallel >= 0.8 * par) ||
    (tpd > 0 && state.dayTokens >= 0.8 * tpd) ||
    (rpd > 0 && state.dayReq >= 0.8 * rpd);
  if (mHot) return 'hot';
  return 'ok';
}

/** 距下一个可放行点的等待毫秒数（分钟窗口刷新 / 次日）。blocked 返回到次日 0 点。 */
export function msUntilReady(state: WindowState, limit: RateLimitBlock | undefined | null): number {
  if (!limit) return 0;
  const lvl = statusOf(state, limit);
  if (lvl === 'blocked') return msUntilNextWindowDay();
  if (lvl === 'busy' || lvl === 'hot') {
    // 分钟维度限制 → 等到下一分钟边界；日维度 → 到次日
    const rpd = normNum(limit.rpd);
    const tpd = normNum(limit.tpd);
    const dailyHit =
      (rpd > 0 && state.dayReq >= rpd) ||
      (tpd > 0 && state.dayTokens >= tpd && limit.tpdBehavior !== 'limitRpm');
    if (dailyHit) return msUntilNextWindowDay();
    const now = Date.now();
    return Math.max(1000, 60_000 - (now % 60_000));
  }
  return 0;
}

// ---------------- 全局作用域注册表 ----------------

const apiScopes = new Map<string, WindowState>(); // `provider:tier:key`
const carrierScopes = new Map<string, WindowState>(); // `provider:tier`
const modelScopes = new Map<string, WindowState>(); // `modelKey`

function newWindowState(): WindowState {
  const now = Date.now();
  const mk = minuteKey(now);
  return {
    reqMin: { minuteKey: mk, count: 0 },
    dayKey: dayKeyIn(now),
    dayReq: 0,
    dayTokens: 0,
    tokMin: { minuteKey: mk, count: 0 },
    parallel: 0,
  };
}

/** 供测试与调用方构造「当前窗口」状态：惰性重置不会误清零预置计数。 */
export function currentWindowState(): WindowState {
  return newWindowState();
}

export function ensureApiScope(provider: string, tier: string, apiKey: string): WindowState {
  const k = `${provider}:${tier}:${apiKey}`;
  let s = apiScopes.get(k);
  if (!s) { s = newWindowState(); apiScopes.set(k, s); }
  return s;
}
export function ensureCarrierScope(provider: string, tier: string): WindowState {
  const k = `${provider}:${tier}`;
  let s = carrierScopes.get(k);
  if (!s) { s = newWindowState(); carrierScopes.set(k, s); }
  return s;
}
export function ensureModelScope(modelKey: string): WindowState {
  let s = modelScopes.get(modelKey);
  if (!s) { s = newWindowState(); modelScopes.set(modelKey, s); }
  return s;
}

export interface GateScopes {
  api: { state: WindowState; limit: RateLimitBlock };
  carrier: { state: WindowState; limit: RateLimitBlock };
  model: { state: WindowState; limit: RateLimitBlock };
}

/**
 * 一次调用同时占用三个作用域的并行额度。
 * 调用前依次 tryAcquire 三个作用域；任一拒绝则回滚已占用者并返回。
 * 成功后调用方在结束时对每个作用域 release()。
 */
export function acquireAll(gates: GateScopes, estTokens = 0): { ok: boolean; reason?: string; effectiveRpm?: number; released: Array<{ release: () => void }> } {
  const taken: Array<{ release: () => void }> = [];
  const tryOne = (g: { state: WindowState; limit: RateLimitBlock }): AcquireResult =>
    tryAcquire(g.state, { limit: g.limit, estTokens });

  const apiRes = tryOne(gates.api);
  if (!apiRes.allowed) return { ok: false, reason: apiRes.reason, released: [] };
  taken.push({ release: () => release(gates.api.state) });

  const carrierRes = tryOne(gates.carrier);
  if (!carrierRes.allowed) {
    for (const t of taken) t.release();
    return { ok: false, reason: carrierRes.reason, released: [] };
  }
  taken.push({ release: () => release(gates.carrier.state) });

  const modelRes = tryOne(gates.model);
  if (!modelRes.allowed) {
    for (const t of taken) t.release();
    return { ok: false, reason: modelRes.reason, released: [] };
  }
  taken.push({ release: () => release(gates.model.state) });

  return { ok: true, effectiveRpm: modelRes.effectiveRpm ?? apiRes.effectiveRpm ?? carrierRes.effectiveRpm, released: taken };
}

/**
 * PG 模式下的三作用域并发许可（跨实例）。
 *
 * 与 acquireAll 的差别：并发占用不写进程内 WindowState.parallel，而是走
 * ConcurrencyLease（PG 行），因此多实例共享同一账本。RPM/TPM/RPD/TPD 仍是
 * 进程内滑动窗口（这些是近似账本，跨实例精确化留待后续接入 PG 计数器）。
 *
 * PG 不可用 → 拒签（fail-closed），绝不放行。
 */
export async function acquireAllPg(
  gates: GateScopes,
  estTokens = 0,
  lease?: { provider: string; tier: string; apiKey: string; modelKey: string; apiMax: number | null; carrierMax: number | null; modelMax: number | null; keyPrefix?: string; ttlMs?: number },
): Promise<{ ok: boolean; reason?: string; effectiveRpm?: number; released: Array<{ release: () => void }> }> {
  const mem = acquireAll(gates, estTokens);
  if (!mem.ok) return { ok: false, reason: mem.reason, released: [] };

  // 内存侧的并行计数立即释放：并联发已由 PG lease 精确持有，避免同一请求被双计。
  for (const t of mem.released) t.release();
  if (!lease) return { ok: false, reason: 'db_unavailable', released: [] };

  const req: LeaseRequest = {
    provider: lease.provider,
    tier: lease.tier as 'FREE' | 'PRO',
    apiKey: lease.apiKey,
    modelKey: lease.modelKey,
    apiMax: lease.apiMax,
    carrierMax: lease.carrierMax,
    modelMax: lease.modelMax,
    keyPrefix: lease.keyPrefix,
    ttlMs: lease.ttlMs,
  };
  const wanted = activeLeaseKeys(req);
  if (wanted.length === 0) return { ok: true, effectiveRpm: mem.effectiveRpm, released: [] };

  const r = await acquireConcurrency(req);
  if (!r.ok) return { ok: false, reason: r.reason ?? 'max_parallel', released: [] };

  return {
    ok: true,
    effectiveRpm: mem.effectiveRpm,
    released: [{ release: () => { for (const h of r.handles) void h.release(); } }],
  };
}

// ---------------- admin 编辑后重建（限额配置即时生效） ----------------

/** 清空某作用域的限额引用（删除供应商/模型时调用）。窗口计数保留，限额由调用方决定。 */
export function dropApiScope(provider: string, tier: string, apiKey: string): void {
  apiScopes.delete(`${provider}:${tier}:${apiKey}`);
}
export function dropCarrierScope(provider: string, tier: string): void {
  carrierScopes.delete(`${provider}:${tier}`);
}
export function dropModelScope(modelKey: string): void {
  modelScopes.delete(modelKey);
}

/** 导出当前各作用域的实时用量快照（admin 面板展示用）。 */
export function scopeSnapshots(): {
  api: Record<string, { parallel: number; dayTokens: number; dayReq: number }>;
  carrier: Record<string, { parallel: number; dayTokens: number; dayReq: number }>;
  model: Record<string, { parallel: number; dayTokens: number; dayReq: number }>;
} {
  const snap = (m: Map<string, WindowState>, keyOf: (k: string, s: WindowState) => string) => {
    const out: Record<string, any> = {};
    for (const [k, s] of m) out[keyOf(k, s)] = { parallel: s.parallel, dayTokens: s.dayTokens, dayReq: s.dayReq };
    return out;
  };
  return {
    api: snap(apiScopes, (k) => k),
    carrier: snap(carrierScopes, (k) => k),
    model: snap(modelScopes, (k) => k),
  };
}
