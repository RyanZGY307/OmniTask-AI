// ================================================================
// RSI 侧独立 AI Provider 配置（knowledge 库 RsiProviderConfig）。
//
// 关键约束（用户 m02000 口径）：RSI 密钥及其 API 配置数据必须保持独立，
// **不得引用普通 API 管理配置记录（ProviderConnection）**。因此这里只读
// 自己的表，与 providerConfig.ts 无任何 join / 外键 / 共享缓存。
//
// 纯逻辑（无 DB 依赖）放在 rsiQuota.ts，本文件只负责持久化与缓存。
// ================================================================
import { prismaKnowledge as prisma, isDbSetupRequired } from '../db';
import { parseRateLimitBlock } from '../rateLimitParse';

export interface RsiProviderInput {
  provider: string;
  tier: 'FREE' | 'PRO';
  baseUrl: string;
  apiKeys: string[];
  apiLimit?: Record<string, unknown>;
  carrierLimit?: Record<string, unknown>;
  rsiModelLimit?: Record<string, unknown>;
  enabled: boolean;
}

export interface RsiProviderRow {
  id: string;
  provider: string;
  tier: string;
  baseUrl: string;
  apiKeys: string[];
  apiLimit: Record<string, unknown>;
  carrierLimit: Record<string, unknown>;
  rsiModelLimit: Record<string, unknown>;
  enabled: boolean;
}

function safeJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

/** 内存缓存（与普通 providerConfig 的缓存相互独立）。 */
const cache = new Map<string, RsiProviderRow>();

export function rsiCacheKey(provider: string, tier: string): string {
  return `${provider}::${tier}`;
}

/** 规范化 + 落库。额度字段落库前必须经 parseRateLimitBlock（非法值抛错）。 */
export async function upsertRsiProvider(input: RsiProviderInput): Promise<RsiProviderRow> {
  const apiLimit = parseRateLimitBlock(input.apiLimit || {});
  const carrierLimit = parseRateLimitBlock(input.carrierLimit || {});
  const rsiModelLimit = parseRateLimitBlock(input.rsiModelLimit || {});
  const keys = (input.apiKeys || []).map((k) => String(k).trim()).filter(Boolean);
  if (keys.length === 0) throw new Error('rsi provider requires at least one api key');

  const row = await prisma.rsiProviderConfig.upsert({
    where: { provider_tier: { provider: input.provider, tier: input.tier } },
    create: {
      provider: input.provider,
      tier: input.tier,
      baseUrl: input.baseUrl,
      apiKeys: JSON.stringify(keys),
      apiLimit: JSON.stringify(apiLimit),
      carrierLimit: JSON.stringify(carrierLimit),
      rsiModelLimit: JSON.stringify(rsiModelLimit),
      enabled: input.enabled,
    },
    update: {
      baseUrl: input.baseUrl,
      apiKeys: JSON.stringify(keys),
      apiLimit: JSON.stringify(apiLimit),
      carrierLimit: JSON.stringify(carrierLimit),
      rsiModelLimit: JSON.stringify(rsiModelLimit),
      enabled: input.enabled,
    },
  });
  const norm = toRow(row);
  cache.set(rsiCacheKey(norm.provider, norm.tier), norm);
  return norm;
}

function toRow(r: {
  id: string; provider: string; tier: string; baseUrl: string;
  apiKeys: string; apiLimit: string; carrierLimit: string; rsiModelLimit: string; enabled: boolean;
}): RsiProviderRow {
  return {
    id: r.id, provider: r.provider, tier: r.tier, baseUrl: r.baseUrl,
    apiKeys: safeJson(r.apiKeys) as unknown as string[],
    apiLimit: safeJson(r.apiLimit),
    carrierLimit: safeJson(r.carrierLimit),
    rsiModelLimit: safeJson(r.rsiModelLimit),
    enabled: r.enabled,
  };
}

/** 列出已启用的 RSI provider（供 RSI 侧模型调用选择，与普通配置无关）。 */
export async function listRsiProviders(tier?: 'FREE' | 'PRO'): Promise<RsiProviderRow[]> {
  const rows = await prisma.rsiProviderConfig.findMany({
    where: tier ? { tier } : {},
    orderBy: { provider: 'asc' },
  });
  return rows.map(toRow);
}

/** 内存缓存优先（RSI 侧调用热路径，避免每次查库）。 */
export async function getRsiProvider(provider: string, tier: 'FREE' | 'PRO'): Promise<RsiProviderRow | null> {
  const ck = rsiCacheKey(provider, tier);
  const hit = cache.get(ck);
  if (hit) return hit;
  try {
    const row = await prisma.rsiProviderConfig.findUnique({
      where: { provider_tier: { provider, tier } },
    });
    if (!row) return null;
    const norm = toRow(row);
    cache.set(ck, norm);
    return norm;
  } catch { return null; }
}

/** 失效缓存（admin 编辑后调用）。 */
export function invalidateRsiProvider(provider: string, tier: 'FREE' | 'PRO'): void {
  cache.delete(rsiCacheKey(provider, tier));
}

/** DB 是否可用于 RSI 配置（未配置库时所有写入拒绝）。 */
export function rsiConfigReady(): boolean {
  return isDbSetupRequired();
}
