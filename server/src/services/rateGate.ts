// ================================================================
// Rate Gate — 一次模型调用前的三作用域限速闸门。
//
// 聚合 rateLimiter 的单 API / 运营商 / 调用模型三类作用域：
//   - 单 API：ProviderConnection.apiLimit（每把 key 独立）
//   - 运营商：ProviderConnection.carrierLimit（该供应商所有 key 统一）
//   - 调用模型：ModelConfig.rateLimit（每个模型独立，经下方注册表）
//
// 调用方（router 免费版轮询 / Pro 手动调用）在真正 POST 之前 acquire，
// 通过则拿到 release 句柄（结束时释放并行占用）；未通过则跳过当前
// key/供应商，轮询切到下一个——这就是「多供应商/API 轮询防额度用尽」。
// ================================================================

import { getProviderConnection } from './providerConfig';
import type { RateLimitBlock } from './rateLimiter';
import {
  ensureApiScope, ensureCarrierScope, ensureModelScope,
  acquireAll, statusOf, msUntilReady, type GateScopes, type LoadLevel,
} from './rateLimiter';

// 模型级限额注册表（内存态）。启动时从 ModelConfig 载入；admin 编辑
// 模型限额时经 setModelRateLimit 即时更新。
const modelRateLimits = new Map<string, RateLimitBlock>();

export function setModelRateLimit(modelKey: string, block: RateLimitBlock | null): void {
  if (!modelKey) return;
  if (block && Object.keys(block).some((k) => (block as any)[k] !== undefined && (block as any)[k] !== 0 && (block as any)[k] !== '')) {
    modelRateLimits.set(modelKey, block);
  } else {
    modelRateLimits.delete(modelKey); // 空限额 = 删除该模型的作用域限额
  }
}

export function getModelRateLimit(modelKey: string): RateLimitBlock {
  return modelRateLimits.get(modelKey) || {};
}

export interface GateInput {
  provider: string;
  tier: 'FREE' | 'PRO';
  apiKey: string;
  modelKey: string;
  estTokens?: number;
}

export interface GateResult {
  ok: boolean;
  reason?: string;
  effectiveRpm?: number;
  /** 请求结束后调用，释放三作用域的并行占用 */
  release: () => void;
}

export function acquireRateGate(input: GateInput): GateResult {
  const conn = getProviderConnection(input.provider, input.tier);
  const apiLimit: RateLimitBlock = conn?.apiLimit || {};
  const carrierLimit: RateLimitBlock = conn?.carrierLimit || {};
  const modelLimit: RateLimitBlock = getModelRateLimit(input.modelKey) || {};

  const estTokens = input.estTokens || 0;

  const gates: GateScopes = {
    api: { state: ensureApiScope(input.provider, input.tier, input.apiKey), limit: apiLimit },
    carrier: { state: ensureCarrierScope(input.provider, input.tier), limit: carrierLimit },
    model: { state: ensureModelScope(input.modelKey), limit: modelLimit },
  };

  const res = acquireAll(gates, estTokens);
  if (!res.ok) {
    return { ok: false, reason: res.reason, release: () => {} };
  }
  const handles = res.released;
  return {
    ok: true,
    reason: undefined,
    effectiveRpm: res.effectiveRpm,
    release: () => { for (const h of handles) h.release(); },
  };
}

// ==================== 负载状态展示（前端模型列表“调用量高/需排队/暂不可用”） ====================

const SEVERITY: Record<LoadLevel, number> = { ok: 0, hot: 1, busy: 2, blocked: 3 };
function worse(a: LoadLevel, b: LoadLevel): LoadLevel {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** 聚合“某模型在某供应商某 tier”的三作用域负载（model + carrier + 最优 key）。 */
export function modelLoadStatus(modelKey: string, provider: string, tier: 'FREE' | 'PRO'): LoadLevel {
  const conn = getProviderConnection(provider, tier);
  let lvl: LoadLevel = 'ok';
  lvl = worse(lvl, statusOf(ensureModelScope(modelKey), getModelRateLimit(modelKey)));
  if (conn?.carrierLimit) lvl = worse(lvl, statusOf(ensureCarrierScope(provider, tier), conn.carrierLimit));
  // 单 API：只要有一把 key 可用即可；全部不可用才降为相应等级
  const keys = conn?.apiKeys || [];
  if (keys.length && conn.apiLimit && Object.keys(conn.apiLimit).some((k) => (conn.apiLimit as any)[k])) {
    const keyLvl = keys.map((k) => statusOf(ensureApiScope(provider, tier, k), conn.apiLimit) as LoadLevel);
    // 最优 key 的可用性（最少严重）
    const best = keyLvl.slice().sort((a, b) => SEVERITY[a] - SEVERITY[b])[0];
    lvl = worse(lvl, best);
  }
  return lvl;
}

// ==================== 自动排队：被限流时等待放行 ====================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface QueueResult {
  ok: boolean;
  blocked?: boolean;      // 硬阻断（当日 TPD 不可用 / RPD 用尽），等不到
  timedOut?: boolean;     // 超过上限仍拥挤
  queuedMs: number;
  effectiveRpm?: number;
  release: () => void;
}

/**
 * 被速率限制时自动排队：轮询 acquireRateGate，busy 则按 msUntilReady 等待后重试，
 * 直到放行或达到 capMs。硬阻断（blocked）直接返回；排队超限返回 timedOut。
 */
export async function awaitAcquireRateGate(input: GateInput, capMs = 20_000): Promise<QueueResult> {
  const conn = getProviderConnection(input.provider, input.tier);
  const start = Date.now();
  for (;;) {
    const gate = acquireRateGate(input);
    if (gate.ok) {
      return {
        ok: true, blocked: false, timedOut: false,
        queuedMs: Date.now() - start, effectiveRpm: gate.effectiveRpm, release: gate.release,
      };
    }
    if (gate.reason === 'blocked') {
      return { ok: false, blocked: true, timedOut: false, queuedMs: Date.now() - start, release: () => {} };
    }
    // busy：计算等待（取三作用域 msUntilReady 的最大值）
    const carrierState = ensureCarrierScope(input.provider, input.tier);
    const modelState = ensureModelScope(input.modelKey);
    const waitMs = Math.max(
      msUntilReady(ensureApiScope(input.provider, input.tier, input.apiKey), conn?.apiLimit),
      msUntilReady(carrierState, conn?.carrierLimit),
      msUntilReady(modelState, getModelRateLimit(input.modelKey)),
    );
    const remaining = capMs - (Date.now() - start);
    if (waitMs >= remaining) {
      return { ok: false, blocked: false, timedOut: true, queuedMs: Date.now() - start, release: () => {} };
    }
    await sleep(Math.min(waitMs, Math.max(500, remaining / 2)));
  }
}
