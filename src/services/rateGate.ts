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
import { parseRateLimitBlock } from './rateLimitParse';
import type { RateLimitBlock } from './rateLimiter';
import {
  ensureApiScope, ensureCarrierScope, ensureModelScope,
  acquireAll, statusOf, msUntilReady, type GateScopes, type LoadLevel,
} from './rateLimiter';
import { isQuotaSwitchable } from './quotaReason';
import { reserveQuota, type QuotaScope, type ReservationResult } from './quotaLedger';

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
  /** 该原因是否属于"数据额度限制"（允许自动切换）；false 时不换 API */
  quotaSwitchable?: boolean;
  effectiveRpm?: number;
  /** 请求结束后调用，释放三作用域的并行占用 */
  release: () => void;
}

/** 候选可用性重检：额度 + enabled + 在线状态 + 能力兼容（切换前必做，用户口径）。 */
export interface PreflightCandidate {
  provider: string;
  tier: 'FREE' | 'PRO';
  apiKey: string;
  modelKey: string;
  requiredCapabilities?: string[];
}

export interface PreflightResult {
  ok: boolean;
  reason?: 'provider_disabled' | 'model_disabled' | 'capability_mismatch' | 'quota_blocked' | 'unknown';
  detail?: string;
}

/**
 * 切换前重检备用配置。检查项（任一不过即拒绝切换）：
 *   1) ProviderConnection.enabled
 *   2) ModelConfig.enabled 且 status==='online'
 *   3) capabilities 覆盖 requiredCapabilities
 *   4) 三作用域额度不是硬阻断（blocked）
 */
export function preflightCandidate(c: PreflightCandidate): PreflightResult {
  const conn = getProviderConnection(c.provider, c.tier);
  if (!conn || conn.enabled === false) return { ok: false, reason: 'provider_disabled' };
  const model = getModelConfigForCheck(c.modelKey);
  if (!model || model.enabled === false) return { ok: false, reason: 'model_disabled' };
  if (model.status && model.status !== 'online') return { ok: false, reason: 'model_disabled', detail: `status=${model.status}` };
  const caps = String(model.capabilities || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const need of c.requiredCapabilities || []) {
    if (caps.length && !caps.includes(need)) return { ok: false, reason: 'capability_mismatch', detail: `缺能力 ${need}` };
  }
  const gate = acquireRateGate({ provider: c.provider, tier: c.tier, apiKey: c.apiKey, modelKey: c.modelKey });
  if (!gate.ok) { gate.release(); return { ok: false, reason: gate.quotaSwitchable ? 'quota_blocked' : 'unknown', detail: gate.reason }; }
  gate.release();
  return { ok: true };
}

/** 轻量读 ModelConfig（不引入 providerConfig 之外的依赖，避免循环）。 */
function getModelConfigForCheck(modelKey: string): { enabled: boolean; status: string; capabilities: string } | null {
  // 闸门职责是限额而非模型启停；这里只做同步内存读取，读不到一律放行（fail-open on check，fail-closed on quota）
  try {
    const { getCachedModelConfig } = require('./providerConfig') as { getCachedModelConfig?: (k: string) => any };
    const m = typeof getCachedModelConfig === 'function' ? getCachedModelConfig(modelKey) : null;
    if (!m) return null;
    return { enabled: m.enabled !== false, status: m.status || 'online', capabilities: m.capabilities || '' };
  } catch { return null; }
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

  // 额度块在进入 acquireAll 前统一过一遍三态解析，非法配置立即抛错（不静默无限）
  const apiBlock = parseRateLimitBlock(conn?.apiLimit ?? {});
  const carrierBlock = parseRateLimitBlock(conn?.carrierLimit ?? {});
  const modelBlock = parseRateLimitBlock(getModelRateLimit(input.modelKey) || {});

  const res = acquireAll({
    api: { state: gates.api.state, limit: apiBlock as unknown as RateLimitBlock },
    carrier: { state: gates.carrier.state, limit: carrierBlock as unknown as RateLimitBlock },
    model: { state: gates.model.state, limit: modelBlock as unknown as RateLimitBlock },
  }, estTokens);
  if (!res.ok) {
    const quotaSwitchable = isQuotaSwitchable(res.reason);
    return { ok: false, reason: res.reason, quotaSwitchable, release: () => {} };
  }
  const handles = res.released;
  return {
    ok: true,
    reason: undefined,
    quotaSwitchable: false,
    effectiveRpm: res.effectiveRpm,
    release: () => { for (const h of handles) h.release(); },
  };
}

// ==================== 跨实例账本闸门（RATE_QUOTA_LEDGER=pg 时启用） ====================

/**
 * 三级额度账本模式开关。默认 memory（进程内滑动窗口，历史行为不变）。
 * 设为 pg 前必须先执行 prisma/migrations/20261108_quota-ledger-cross-instance.up.sql。
 * PG 侧不可用时 fail-closed（拒签），绝不放行——不突破上限优先于可用性。
 */
export function ledgerMode(): 'memory' | 'pg' {
  return (process.env.RATE_QUOTA_LEDGER || '').toLowerCase() === 'pg' ? 'pg' : 'memory';
}

export interface LedgerGateResult {
  ok: boolean;
  reason?: string;
  quotaSwitchable?: boolean;
  effectiveRpm?: number;
  /** 结束时必须调用：committed（带实际 token）/ released / uncertain */
  settle: (outcome: { status: 'committed' | 'released' | 'uncertain'; actualTokens?: number; note?: string }) => Promise<void>;
  release: () => void;
}

function apiScopeId(provider: string, tier: string, apiKey: string): string {
  return `${provider}:${tier}:${String(apiKey).slice(-8)}`;
}

/**
 * PG 账本版三作用域闸门。与 acquireRateGate 的差别：
 *  - RPM/TPM/RPD/TPD 走 PG 行级原子抢占（多实例共享同一账本，不超卖）；
 *  - 返回 settle 句柄，请求结束后按实际 token 结算（多退少补/保守计费）。
 * 额度配置仍来自 ProviderConnection / ModelConfig，口径与 memory 模式一致。
 */
export async function acquireRateGateLedger(input: GateInput): Promise<LedgerGateResult> {
  const conn = getProviderConnection(input.provider, input.tier);
  const apiBlock = parseRateLimitBlock(conn?.apiLimit ?? {});
  const carrierBlock = parseRateLimitBlock(conn?.carrierLimit ?? {});
  const modelBlock = parseRateLimitBlock(getModelRateLimit(input.modelKey) || {});
  const estTokens = Math.max(0, Math.floor(input.estTokens || 0));

  const scopes: QuotaScope[] = [
    { level: 'api', scopeId: apiScopeId(input.provider, input.tier, input.apiKey) },
    { level: 'carrier', scopeId: `${input.provider}:${input.tier}` },
    { level: 'model', scopeId: input.modelKey },
  ];
  const limits: Record<string, { rpm?: number; tpm?: number; rpd?: number; tpd?: number }> = {
    api: apiBlock as any, carrier: carrierBlock as any, model: modelBlock as any,
  };

  const r: ReservationResult = await reserveQuota({
    scopes, estTokens, limits, ttlMs: 300_000,
    idempotencyKey: undefined,
    provider: input.provider, tier: input.tier, apiKey: String(input.apiKey).slice(-8),
    modelKey: input.modelKey, origin: 'chat',
  });
  if (!r.ok) {
    return { ok: false, reason: r.reason, quotaSwitchable: isQuotaSwitchable(r.reason), settle: async () => {}, release: () => {} };
  }
  const settleFn = r.settle ?? (async () => {});
  return {
    ok: true, quotaSwitchable: false, effectiveRpm: undefined,
    settle: async (o) => { await settleFn(o); },
    release: () => {},
  };
}

/** 账本模式下的排队版：busy 等待、blocked 直接返、超时 timedOut。 */
export async function awaitAcquireRateGateLedger(input: GateInput, capMsOverride?: number): Promise<{
  ok: boolean; blocked?: boolean; timedOut?: boolean; queuedMs: number;
  settle: LedgerGateResult['settle']; release: () => void; reason?: string;
}> {
  const capMs = capMsOverride && capMsOverride > 0 ? capMsOverride : queueCapMs();
  const start = Date.now();
  for (;;) {
    const g = await acquireRateGateLedger(input);
    if (g.ok) return { ok: true, queuedMs: Date.now() - start, settle: g.settle, release: g.release };
    if (g.reason === 'blocked') return { ok: false, blocked: true, queuedMs: Date.now() - start, settle: async () => {}, release: () => {}, reason: g.reason };
    const remaining = capMs - (Date.now() - start);
    if (remaining <= 0) return { ok: false, timedOut: true, queuedMs: Date.now() - start, settle: async () => {}, release: () => {}, reason: g.reason };
    await sleep(Math.max(500, Math.min(remaining / 2, 5000)));
  }
}

/** 非额度类预检（不消耗名额）：enabled / status / capabilities。切换前必做。 */
export function preflightCandidateNoQuota(c: PreflightCandidate): { ok: boolean; reason?: string; detail?: string } {
  const conn = getProviderConnection(c.provider, c.tier);
  if (!conn || conn.enabled === false) return { ok: false, reason: 'provider_disabled' };
  const model = getModelConfigForCheck(c.modelKey);
  if (!model || model.enabled === false) return { ok: false, reason: 'model_disabled' };
  if (model.status && model.status !== 'online') return { ok: false, reason: 'model_disabled', detail: `status=${model.status}` };
  const caps = String(model.capabilities || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const need of c.requiredCapabilities || []) {
    if (caps.length && !caps.includes(need)) return { ok: false, reason: 'capability_mismatch', detail: `缺能力 ${need}` };
  }
  return { ok: true };
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
/** 排队上限：RATE_QUEUE_MAX_WAIT_MS（毫秒），默认 20000（与历史行为一致）。 */
export function queueCapMs(): number {
  const v = Number(process.env.RATE_QUEUE_MAX_WAIT_MS);
  return Number.isFinite(v) && v > 0 ? v : 20_000;
}

export async function awaitAcquireRateGate(input: GateInput, capMsOverride?: number): Promise<QueueResult> {
  const capMs = capMsOverride && capMsOverride > 0 ? capMsOverride : queueCapMs();
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
