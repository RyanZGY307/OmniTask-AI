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
// 全部为内存态（进程内滑动窗口）；重启即清零，不跨进程共享。
// 用于「多供应商/API 轮询」时的选择与拒绝判断，防止单一 key 额度用尽
// 直接报错——到达限制的作用域会被跳过，自动切到下一个可用作用域。
// ================================================================

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

function utcDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
function minuteKey(now = Date.now()): string {
  return String(Math.floor(now / 60_000));
}

function norm(v: number | undefined | null): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0; // 0 / undefined / '-' → 无限
  return n;
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
  const dk = utcDayKey(now);

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

  const rpm = norm(limit.rpm);
  const tpm = norm(limit.tpm);
  const rpd = norm(limit.rpd);
  const maxParallel = norm(limit.maxParallel);
  const tpd = norm(limit.tpd);
  const behavior: TpdBehavior = limit.tpdBehavior === 'limitRpm' ? 'limitRpm' : 'block';
  const tpdLimitRpm = norm(limit.tpdLimitRpm);

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
  // 并行
  if (maxParallel > 0 && state.parallel >= maxParallel) {
    return { allowed: false, reason: 'rate_limited', effectiveRpm };
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

function msUntilNextUtcDay(now = Date.now()): number {
  const dt = new Date(now);
  dt.setUTCHours(24, 0, 0, 0);
  return Math.max(0, dt.getTime() - now);
}

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
  const mBusy =
    (rpm > 0 && state.reqMin.count >= rpm) ||
    (tpm > 0 && state.tokMin.count >= tpm) ||
    (par > 0 && state.parallel >= par);
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
  if (lvl === 'blocked') return msUntilNextUtcDay();
  if (lvl === 'busy' || lvl === 'hot') {
    // 分钟维度限制 → 等到下一分钟边界；日维度 → 到次日
    const rpd = normNum(limit.rpd);
    const tpd = normNum(limit.tpd);
    const dailyHit =
      (rpd > 0 && state.dayReq >= rpd) ||
      (tpd > 0 && state.dayTokens >= tpd && limit.tpdBehavior !== 'limitRpm');
    if (dailyHit) return msUntilNextUtcDay();
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
  const mk = minuteKey();
  return {
    reqMin: { minuteKey: mk, count: 0 },
    dayKey: utcDayKey(),
    dayReq: 0,
    dayTokens: 0,
    tokMin: { minuteKey: mk, count: 0 },
    parallel: 0,
  };
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
