// ================================================================
// Auto Model Router 2.0 — Dynamic, adaptive model selection
// No hardcoded model lists; reads from dynamic config at runtime
// ================================================================

import { getDynamicModels, type ModelRegistryEntry } from './configSync';
import { modelLoadStatus } from './rateGate';
import { TaskClassification } from './taskClassifier';
import { getApiKey } from './apiKeyPool';
import {
  recordSuccess,
  recordFailure,
  recordVerification,
} from './modelPerformanceStore';

// ==================== Routing Decision Interface ====================

export interface RoutingDecision {
  model: string;
  reason: string;
  fallbacks: string[];
    telemetry: Record<string, any>;
  // 免费版轮询命中时携带的具体供应商/key 与速率闸门释放句柄（Pro 手动选择为空）
  provider?: string;
  key?: string;
  tier?: 'FREE' | 'PRO';
  effectiveRpm?: number;
  release?: () => void;
}

// ==================== Tier Filtering ====================

// ULTRA is a retired tier: legacy Ultra users resolve to the PRO rung
// (index 1) so they keep the full model set Pro now ships.
const TIER_HIERARCHY: Record<string, number> = { STANDARD: 0, FREE: 0, PRO: 1, ULTRA: 1 };

function getUserTierLevel(user: any): number {
  return TIER_HIERARCHY[user.subscriptionTier] ?? 0;
}

function filterByTier(entry: ModelRegistryEntry, user: any): boolean {
  if (entry.category === 'image' || entry.category === 'video') return true;
  const userTierIdx = getUserTierLevel(user);
  const modelTierIdx = TIER_HIERARCHY[entry.tier] ?? 0;
  return userTierIdx >= modelTierIdx;
}

// ==================== Main Router Function ====================
//
// 模型自动选择子系统已删除（按产品要求）。行为：
//   - Pro/ULTRA 且用户手动选了模型（requestedModel 非 'auto'）→ 直接用该模型。
//   - 其余（免费版 STANDARD/FREE，或 Pro 未选）→ 跨「供应商 × API × 模型」
//     纯轮询（不看意图），逐个过 rateGate；某把 key/供应商达限即自动切下一个。
// 用户意图分析（classifyTask / taskClassifier）在 chat.ts 上游独立运行，
// 保留用于提示词构建；本路由不再做基于意图/评分的自动模型挑选。

// 纯手动选择模式下跨供应商×模型轮询已移除（原 freeModelsByProvider/freeProviderCursor）。

export function routeModel(
  user: any,
  requestedModel?: string,
  mode?: string,
  taskClassification?: TaskClassification,
): RoutingDecision {
  const telemetry: RoutingDecision['telemetry'] = { candidateCount: 0, filteredCount: 0, filterReasons: [], fastPath: '' };

  // ---- 1) 手动选择（全用户）→ 直接调用所选模型；限流时排队/阻断（buildAgentChat），不切到其他模型 ----
  if (requestedModel && requestedModel !== 'auto') {
    const resolved = resolveModelKey(requestedModel);
    const entry = resolved ? getDynamicModels()[resolved] : undefined;
    if (resolved && entry && filterByTier(entry, user)) {
      return {
        model: resolved, reason: 'user_selected', fallbacks: [],
        provider: entry.provider, tier: entry.tier === 'PRO' ? 'PRO' : 'FREE',
        telemetry: { ...telemetry, fastPath: 'manual' },
      };
    }
    // 选中模型不存在/不可用/越层 → 落到下方默认选择
  }

  // ---- 2) 未选择/自动/无效选择 → 规则默认选择 ----
  // FREE（STANDARD）：最快模型直选；提供商限流 blocked 才切下一个（pickFastestModelForUser）。
  // PRO/ULTRA：层级内质量最高的可用 LLM（pickMostGeneralModel，保持原规则）。
  const chosen = getUserTierLevel(user) <= 0 ? pickFastestModelForUser(user) : pickMostGeneralModel(user);
  if (chosen) {
    const entry = getDynamicModels()[chosen]!;
    return {
      model: chosen, reason: 'default_selected', fallbacks: [],
      provider: entry.provider, tier: entry.tier === 'PRO' ? 'PRO' : 'FREE',
      telemetry: { ...telemetry, fastPath: 'default' },
    };
  }

  // 绝对兜底：任一 online+enabled 有 key 的 LLM；再否则报错
  const anyModel = Object.entries(getDynamicModels())
    .filter(([, e]) => e.enabled && e.status === 'online' && e.category !== 'image' && e.category !== 'video' && getApiKey(e.provider))
    .map(([key]) => key)
    .sort((a, b) => (getDynamicModels()[b]?.contextWindow ?? 0) - (getDynamicModels()[a]?.contextWindow ?? 0))[0];
  if (anyModel) {
    return { model: anyModel, reason: 'no_executable_model_last_resort', fallbacks: [], telemetry };
  }
  throw new Error('No executable model available in registry');
}

// Most-general executable model for a user: highest qualityProfile, then
// largest contextWindow, among tier-eligible enabled+online models that have
// an API key available. No hardcoded model names (R1).
function pickMostGeneralModel(user: any): string | null {
  const registry = getDynamicModels();
  const candidates = Object.entries(registry)
    .filter(([key, e]) => {
      if (e.category === 'image' || e.category === 'video') return false;
      if (!e.enabled || e.status === 'offline') return false;
      if (!filterByTier(e, user)) return false;
      if (!getApiKey(e.provider)) return false;
      return true;
    });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const qa = a[1].qualityProfile ?? 0;
    const qb = b[1].qualityProfile ?? 0;
    if (qb !== qa) return qb - qa;
    return (b[1].contextWindow ?? 0) - (a[1].contextWindow ?? 0);
  });
  return candidates[0][0];
}

export function resolveModelKey(key?: string): string | undefined {
  if (!key) return key;
  // Direct match
  if (getDynamicModels()[key]) return key;
  // Handle common aliases
  const aliases: Record<string, string> = {
    'agnes': 'agnes-2.5-flash',
    'gemini': 'gemini-3.8-flash',
    'deepseek': 'deepseek-v4.1-flash',
    'mimo': 'mimo-v2.6-flash',
    'mimo-pro': 'mimo-v2.6-pro',
  };
  return aliases[key] || key;
}

export function pickMostGeneralModelForUser(user: any): string | null {
  return pickMostGeneralModel(user);
}

// 最快模型直选（免费版规则：无质量排名/智能系统）：
// tier 内可用 LLM 中 flash 系优先（最快），注册表顺序稳定；提供商限流已 blocked 的直接跳过（仅限流切换，未达限不切换）。
export function pickFastestModelForUser(user: any): string | null {
  const registry = getDynamicModels();
  const candidates = Object.entries(registry).filter(([key, e]) => {
    if (e.category === 'image' || e.category === 'video') return false;
    if (!e.enabled || e.status === 'offline') return false;
    if (!filterByTier(e, user)) return false;
    if (!getApiKey(e.provider)) return false;
    if (modelLoadStatus(key, e.provider, e.tier === 'PRO' ? 'PRO' : 'FREE') === 'blocked') return false;
    return true;
  });
  if (candidates.length === 0) return null;
  const flashRank = (e: ModelRegistryEntry) => (/flash/i.test(e.apiModel || '') ? 1 : 0);
  candidates.sort((a, b) => flashRank(b[1]) - flashRank(a[1]));
  return candidates[0][0];
}

// ==================== Post-Execution Feedback ====================

export function recordRoutingResult(modelKey: string, success: boolean, ttftMs?: number, tokensPerSec?: number, verificationPassed?: boolean): void {
  if (success) {
    recordSuccess(modelKey, ttftMs ?? 500, tokensPerSec ?? 50);
    if (verificationPassed !== undefined) {
      recordVerification(modelKey, verificationPassed);
    }
  } else {
    recordFailure(modelKey, 'error');
  }
}

export function recordRoutingFallback(fromModel: string, toModel: string): void {
  recordFailure(fromModel, 'fallback');
  recordSuccess(toModel, 300, 60);
}

export function recordRoutingRateLimit(modelKey: string): void {
  recordFailure(modelKey, 'rate_limit');
}

export function recordRoutingTimeout(modelKey: string): void {
  recordFailure(modelKey, 'timeout');
}
