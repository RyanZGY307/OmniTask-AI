// ================================================================
// RSI 侧三级额度闸门（与普通额度完全隔离）。
//
// 硬约束（用户 m02000）：RSI 的 API 配置与额度数据独立，不引用 ProviderConnection。
// 因此本文件自己读 RsiProviderConfig，自己持 leaseKey（前缀 rsi:），
// 只复用算法与解析规则（rateLimiter / rateLimitParse），不复用对方的账本。
//
// 三级：单 API（apiLimit）/ 运营商（carrierLimit）/ 模型（rsiModelLimit），
// 每级 RPM/TPM/RPD/TPD/最大并发；TPD 到达后 block（停用当日）或 limitRpm（降速）。
// ================================================================
import { type RsiProviderRow } from './rsiProviderConfig';
import type { RateLimitBlock } from '../rateLimiter';
import { ensureApiScope, ensureCarrierScope, ensureModelScope, acquireAll, type GateScopes } from '../rateLimiter';
import { acquireConcurrency, type LeaseRequest, type LeaseScope } from '../concurrencyLease';

export interface RsiGateInput {
  provider: string;
  tier: 'FREE' | 'PRO';
  modelKey: string;
  apiKey: string;
  estTokens?: number;
}

export interface RsiGateResult {
  ok: boolean;
  reason?: string;
  /** 仅数据额度类为 true；并发满/超时/5xx/401/403/参数错一律 false（不得切换） */
  quotaSwitchable?: boolean;
  effectiveRpm?: number;
  release: () => void;
}

function blockOf(row: RsiProviderRow, which: 'apiLimit' | 'carrierLimit' | 'rsiModelLimit'): RateLimitBlock {
  const raw = row[which] || {};
  return {
    rpm: raw.rpm as number | undefined,
    tpm: raw.tpm as number | undefined,
    rpd: raw.rpd as number | undefined,
    maxParallel: raw.maxParallel as number | undefined,
    tpd: raw.tpd as number | undefined,
    tpdBehavior: raw.tpdBehavior === 'limitRpm' ? 'limitRpm' : 'block',
    tpdLimitRpm: raw.tpdLimitRpm as number | undefined,
  };
}

/** RSI 专用的三作用域 key：加 rsi: 前缀，与普通账本物理隔离。 */
export function rsiScopeKeys(p: { provider: string; tier: string; apiKey: string; modelKey: string }) {
  return {
    api: `rsi:api:${p.provider}:${p.tier}:${p.apiKey.slice(-8)}`,
    carrier: `rsi:carrier:${p.provider}:${p.tier}`,
    model: `rsi:model:${p.provider}:${p.modelKey}`,
  };
}

/**
 * RSI 侧取闸门。三级依次占，任一拒则回滚已占；
 * 并发占用同样走进程内窗口（与普通额度一致，PG 化走同一 acquireAllPg 路径）。
 */
export function acquireRsiGate(input: RsiGateInput): RsiGateResult {
  const row = getRsiProviderSync(input.provider, input.tier);
  if (!row) return { ok: false, reason: 'db_unavailable', quotaSwitchable: false, release: () => {} };
  if (!row.enabled) return { ok: false, reason: 'disabled', quotaSwitchable: false, release: () => {} };

  const keys = rsiScopeKeys(input);
  const scopes: GateScopes = {
    api: { state: ensureApiScope(input.provider, input.tier, keys.api), limit: blockOf(row, 'apiLimit') },
    carrier: { state: ensureCarrierScope(input.provider, input.tier), limit: blockOf(row, 'carrierLimit') },
    model: { state: ensureModelScope(keys.model), limit: blockOf(row, 'rsiModelLimit') },
  };
  const r = acquireAll(scopes, input.estTokens || 0);

  if (!r.ok) {
    for (const t of r.released) t.release();
  }
  const switchable = r.reason === 'blocked' || r.reason === 'rate_limited';
  return {
    ok: r.ok,
    reason: r.reason,
    quotaSwitchable: switchable,
    effectiveRpm: r.effectiveRpm,
    release: () => { for (const t of r.released) t.release(); },
  };
}

/**
 * PG 跨实例并发许可（RSI 专用前缀 rsi:，与普通额度账本物理隔离）。
 * 依次占用三级；任一被拒则回滚已占用者。失败 reason 见 LeaseResult：
 *   max_parallel（并发满）/ concurrency_error / db_unavailable。
 */
export async function acquireRsiConcurrency(p: {
  provider: string; tier: 'FREE' | 'PRO'; apiKey: string; modelKey: string;
  apiMax: number | null; carrierMax: number | null; modelMax: number | null;
}): Promise<{ ok: boolean; reason?: string; release: () => Promise<void> }> {
  const req: LeaseRequest = {
    provider: p.provider, tier: p.tier, apiKey: p.apiKey, modelKey: p.modelKey,
    apiMax: p.apiMax, carrierMax: p.carrierMax, modelMax: p.modelMax,
    keyPrefix: 'rsi:',
  };
  const r = await acquireConcurrency(req);
  const release = async () => { for (const h of r.handles) { try { await h.release(); } catch { /* 已过期 */ } } };
  if (!r.ok) return { ok: false, reason: r.reason, release };
  return { ok: true, release };
}

export type { LeaseScope };

// ---- 同步缓存读取（热路径不查库；由 primeRsiProviderCache 预热） ----
const syncCache = new Map<string, RsiProviderRow>();
export function primeRsiProviderCache(rows: RsiProviderRow[]): void {
  for (const r of rows) syncCache.set(`${r.provider}::${r.tier}`, r);
}
function getRsiProviderSync(provider: string, tier: 'FREE' | 'PRO'): RsiProviderRow | null {
  return syncCache.get(`${provider}::${tier}`) || null;
}
