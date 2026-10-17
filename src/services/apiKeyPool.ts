// ================================================================
// Key Pool Manager（tier 感知 + 纯轮询 + 速率闸门）。
//
// 免费/Pro 供应商完全分离：key 池按 `provider#tier` 分区。
// - API key 无数量上限（原 30 把封顶已移除）。
// - 免费版：`acquireFreeSlot` 跨「供应商 × API key」纯轮询，逐一把过
//   rateGate（单API/运营商/调用模型三类额度）；某把 key 到达限制（TPD
//   block 等）即自动切到下一把 / 下一个供应商，防止单一 key 额度用尽报错。
// - 调用方拿到 release 句柄，请求结束后释放并行占用。
//
// 凭据来自 DB（ProviderConnection，admin 在 /admin/models 维护）。
// ================================================================

import { log } from './logger';
import { getProviderConnections, getProviderBaseUrl, type ProviderTier } from './providerConfig';
import { PROVIDER_BASE_URLS } from '../config';
import { acquireRateGate, type GateResult } from './rateGate';

interface KeySlot {
  key: string;
  provider: string;
  tier: ProviderTier;
  index: number;
  failCount: number;
  lastFailAt: number | null;
  cooldownUntil: number | null;
  totalCalls: number;
  totalErrors: number;
  avgLatency: number;
}

const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 300_000;
const MAX_CONSECUTIVE_FAILS = 3;
const RESET_FAILS_AFTER_MS = 300_000;

const pools = new Map<string, KeySlot[]>(); // provider#tier → slots

function slotFor(provider: string, tier: ProviderTier, index: number, key: string): KeySlot {
  return {
    key, provider, tier, index,
    failCount: 0, lastFailAt: null, cooldownUntil: null,
    totalCalls: 0, totalErrors: 0, avgLatency: 0,
  };
}

function poolKey(provider: string, tier: ProviderTier): string {
  return `${provider}#${tier}`;
}

// ==================== Rebuild ====================

export function initApiKeyPools(): void { rebuildApiKeyPools(); }

export function rebuildApiKeyPools(): void {
  const prev = new Map<string, KeySlot>();
  for (const [pk, slots] of pools) {
    for (const s of slots) prev.set(`${pk}#${s.key}`, s);
  }
  pools.clear();

  const conns = getProviderConnections(); // 全 tier
  const seen = new Set<string>();
  for (const conn of conns) {
    if (!conn.enabled || conn.apiKeys.length === 0) continue;
    const tier: ProviderTier = conn.tier || 'FREE';
    const pk = poolKey(conn.provider, tier);
    seen.add(pk);
    const slots = conn.apiKeys.map((key, i) => {
      const old = prev.get(`${pk}#${key}`);
      const slot = slotFor(conn.provider, tier, i + 1, key);
      if (old) {
        slot.totalCalls = old.totalCalls;
        slot.totalErrors = old.totalErrors;
        slot.avgLatency = old.avgLatency;
        slot.failCount = old.failCount;
        slot.lastFailAt = old.lastFailAt;
        slot.cooldownUntil = old.cooldownUntil;
      }
      return slot;
    });
    pools.set(pk, slots);
  }
  for (const [pk, slots] of pools) {
    console.log(`[ApiKeyPool] ${pk}: ${slots.length} key(s) loaded (DB)`);
  }
}

// ==================== 单供应商取 key（兼容旧调用点） ====================

export function getApiKey(provider: string, tier: ProviderTier = 'FREE'): string | null {
  const pool = pools.get(poolKey(provider, tier));
  if (!pool || pool.length === 0) return null;
  const now = Date.now();
  const healthy = pool.filter((slot) => {
    if (slot.cooldownUntil && now < slot.cooldownUntil) return false;
    if (slot.cooldownUntil && now >= slot.cooldownUntil) { slot.cooldownUntil = null; slot.failCount = 0; }
    if (slot.lastFailAt && now - slot.lastFailAt > RESET_FAILS_AFTER_MS) { slot.failCount = 0; slot.lastFailAt = null; }
    return slot.failCount < MAX_CONSECUTIVE_FAILS;
  });
  if (healthy.length === 0) {
    const sorted = [...pool].sort((a, b) => (a.cooldownUntil || Infinity) - (b.cooldownUntil || Infinity));
    log('WARN', 'ApiKeyPool', `All ${provider}#${tier} keys in cooldown, using least-cooled`);
    return sorted[0]?.key ?? null;
  }
  healthy.sort((a, b) => a.totalCalls - b.totalCalls || a.failCount - b.failCount);
  return healthy[0].key;
}

// ==================== 报告成功 / 失败 ====================

export function reportKeySuccess(provider: string, key: string, latencyMs: number, tier: ProviderTier = 'FREE'): void {
  const pool = pools.get(poolKey(provider, tier));
  const slot = pool?.find((s) => s.key === key);
  if (!slot) return;
  slot.totalCalls++;
  slot.failCount = 0;
  slot.lastFailAt = null;
  slot.cooldownUntil = null;
  slot.avgLatency = slot.avgLatency === 0 ? latencyMs : slot.avgLatency * 0.8 + latencyMs * 0.2;
}

export function reportKeyFailure(provider: string, key: string, error?: string, tier: ProviderTier = 'FREE'): void {
  const pool = pools.get(poolKey(provider, tier));
  const slot = pool?.find((s) => s.key === key);
  if (!slot) return;
  slot.totalCalls++;
  slot.totalErrors++;
  slot.failCount++;
  slot.lastFailAt = Date.now();
  if (slot.failCount >= MAX_CONSECUTIVE_FAILS) {
    const cooldownMs = Math.min(COOLDOWN_BASE_MS * Math.pow(2, slot.failCount - MAX_CONSECUTIVE_FAILS), COOLDOWN_MAX_MS);
    slot.cooldownUntil = Date.now() + cooldownMs;
    log('WARN', 'ApiKeyPool', `${provider}#${tier} key #${slot.index} cooldown ${cooldownMs}ms: ${error || 'unknown'}`);
  }
}

// ==================== 免费版：跨「供应商 × API」纯轮询 ====================

// 轮询游标：每次从上次位置继续，实现供应商与 key 的双重 round-robin。
let freeCursor = 0;

export interface SlotSelection {
  provider: string;
  tier: ProviderTier;
  key: string;
  /** 释放并行占用（请求结束必调） */
  release: () => void;
  /** 命中速率闸门时的实际生效 RPM（TPD 降级等） */
  effectiveRpm?: number;
}

/**
 * 免费版轮询：遍历 FREE 供应商连接的 key，逐个过 rateGate；第一个通过的
 * 即返回。到达限制（TPD block / 429 冷却）的 key 自动被跳过 → 切下一个。
 * 全部不通过返回 null（调用方可重试或提示「额度已用尽，稍后再试」）。
 */
export function acquireFreeSlot(modelKey: string, estTokens = 0): SlotSelection | null {
  const freeConns = getProviderConnections('FREE').filter((c) => c.enabled && c.apiKeys.length > 0);
  if (freeConns.length === 0) return null;

  // 供应商轮询：从游标偏移
  const orderedConns = [
    ...freeConns.slice(freeCursor % freeConns.length),
    ...freeConns.slice(0, freeCursor % freeConns.length),
  ];
  freeCursor++;

  let lastGate: GateResult | null = null;
  for (const conn of orderedConns) {
    const pk = poolKey(conn.provider, 'FREE');
    const pool = pools.get(pk) || conn.apiKeys.map((k, i) => slotFor(conn.provider, 'FREE', i + 1, k));
    if (!pools.has(pk)) pools.set(pk, pool);

    // key 轮询（least-used 起点，逐个过闸门）
    const orderedKeys = [...pool].sort((a, b) => a.totalCalls - b.totalCalls);
    for (const slot of orderedKeys) {
      if (slot.cooldownUntil && Date.now() < slot.cooldownUntil) continue; // 冷却跳过
      const gate = acquireRateGate({
        provider: conn.provider,
        tier: 'FREE',
        apiKey: slot.key,
        modelKey,
        estTokens,
      });
      lastGate = gate;
      if (gate.ok) {
        slot.totalCalls++;
        return { provider: conn.provider, tier: 'FREE', key: slot.key, release: gate.release, effectiveRpm: gate.effectiveRpm };
      }
      // 未通过：不释放（acquireAll 已回滚），尝试下一个 key
    }
  }

  if (lastGate && !lastGate.ok) {
    log('WARN', 'ApiKeyPool', `FREE round-robin: all slots blocked (${lastGate.reason}); model=${modelKey}`);
  }
  return null;
}

/** Pro 版：指定供应商内选一把能过闸门的 key（手动选模型后调用）。 */
export function acquireProSlot(provider: string, modelKey: string, estTokens = 0): SlotSelection | null {
  const conn = getProviderConnections('PRO').find((c) => c.provider === provider && c.enabled);
  const pool = pools.get(poolKey(provider, 'PRO'));
  if (!pool || pool.length === 0) return null;
  const keys = [...pool].sort((a, b) => a.totalCalls - b.totalCalls);
  for (const slot of keys) {
    if (slot.cooldownUntil && Date.now() < slot.cooldownUntil) continue;
    const gate = acquireRateGate({ provider, tier: 'PRO', apiKey: slot.key, modelKey, estTokens });
    if (gate.ok) {
      slot.totalCalls++;
      return { provider, tier: 'PRO', key: slot.key, release: gate.release, effectiveRpm: gate.effectiveRpm };
    }
  }
  log('WARN', 'ApiKeyPool', `PRO ${provider}: all keys blocked for model=${modelKey}`);
  return null;
}

// ==================== 轮询式调用（key 轮换 + 429/5xx 切下一把） ====================

export interface CallResult {
  ok: boolean;
  status: number;
  body: any;
  latencyMs: number;
  keyUsed: number;
}

export async function callWithKeyRotation(
  provider: string,
  tier: ProviderTier,
  requestFn: (apiKey: string) => Promise<Response>,
  maxRetries?: number,
): Promise<CallResult> {
  const pool = pools.get(poolKey(provider, tier)) || [];
  const retries = maxRetries ?? Math.max(pool.length, 1);
  let lastError: any = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    const apiKey = getApiKey(provider, tier);
    if (!apiKey) throw new Error(`No API key configured for ${provider}#${tier}`);
    const slot = pool.find((s) => s.key === apiKey);
    const keyIndex = slot?.index || 0;
    const start = Date.now();
    try {
      const res = await requestFn(apiKey);
      const latencyMs = Date.now() - start;
      const body = await res.json().catch(() => null);
      if (res.ok) {
        reportKeySuccess(provider, apiKey, latencyMs, tier);
        return { ok: true, status: res.status, body, latencyMs, keyUsed: keyIndex };
      }
      if (res.status === 429 || res.status >= 500) {
        reportKeyFailure(provider, apiKey, `HTTP ${res.status}`, tier);
        lastError = { status: res.status, body };
        continue;
      }
      reportKeySuccess(provider, apiKey, latencyMs, tier);
      return { ok: false, status: res.status, body, latencyMs, keyUsed: keyIndex };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      reportKeyFailure(provider, apiKey, err.message, tier);
      lastError = err;
    }
  }
  throw lastError || new Error(`All ${provider}#${tier} keys exhausted`);
}

// ==================== 统计（admin 用） ====================

export function getKeyPoolStats(): Record<string, any[]> {
  const stats: Record<string, any[]> = {};
  for (const [pk, pool] of pools) {
    const provider = pk.split('#')[0];
    stats[pk] = pool.map((slot) => ({
      index: slot.index,
      keyPreview: `${slot.key.substring(0, 8)}...`,
      failCount: slot.failCount,
      inCooldown: slot.cooldownUntil ? Date.now() < slot.cooldownUntil : false,
      totalCalls: slot.totalCalls,
      totalErrors: slot.totalErrors,
      baseUrl: getProviderBaseUrl(provider, slot.tier) || PROVIDER_BASE_URLS[provider] || '',
    }));
  }
  return stats;
}

export function getKeyPoolSize(provider: string, tier: ProviderTier = 'FREE'): number {
  return pools.get(poolKey(provider, tier))?.length || 0;
}

export function hasAnyKeyInPools(): boolean {
  for (const slots of pools.values()) if (slots.length > 0) return true;
  return false;
}
