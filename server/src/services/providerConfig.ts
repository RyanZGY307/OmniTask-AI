// ================================================================
// Provider Connections — admin-managed Base URLs + API key pools.
//
// 免费/Pro 供应商「完全分离」：同一个 provider 名可以有 FREE 与 PRO 两套
// 连接（不同 URL / API key / 限额），互不影响。因此 ProviderConnection
// 的联合主键是 [provider, tier]。
//
// - 完整 URL 不再拼接：admin 存的是完整 chat/completions 端点（如
//   https://apihub.agnes-ai.com/v1/chat/completions），调用时原样 POST。
// - API key 无数量上限（原先 30 把封顶已移除）。
// - 三类限速（单 API / 运营商 / 调用模型）以 JSON 存于本表与 ModelConfig，
//   由 services/rateLimiter 在每次调用时执行。
//
// 本服务把 DB 行载入内存缓存；key 池由 apiKeyPool.rebuildApiKeyPools() 重建。
// ================================================================

import { prismaUser } from './db';
import { PROVIDER_BASE_URLS } from '../config';
import { log } from './logger';
import type { RateLimitBlock } from './rateLimiter';

export type ProviderTier = 'FREE' | 'PRO';

export interface ProviderConnectionRow {
  provider: string;
  tier: ProviderTier;
  label: string;
  /** 完整 URL（不再拼接）——chat/completions 端点 */
  baseUrl: string;
  baseUrlRoot: string | null;
  /** 无数量上限 */
  apiKeys: string[];
  /** 单 API 限制（每把 key 独立额度）；空对象 = 无限 */
  apiLimit: RateLimitBlock;
  /** 运营商限制（该供应商所有 API 统一额度）；空对象 = 无限 */
  carrierLimit: RateLimitBlock;
  enabled: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export const PROVIDER_CATEGORIES: Record<string, { label: string; protocol: 'openai' | 'google' }> = {
  agnes:    { label: 'Agnes',    protocol: 'openai' },
  deepseek: { label: 'DeepSeek', protocol: 'openai' },
  openai:   { label: 'ChatGPT',  protocol: 'openai' },
  google:   { label: 'Gemini',   protocol: 'google' },
  xiaomi:   { label: 'Xiaomi MiMO', protocol: 'openai' },
};

// In-memory cache of loaded connections (provider#tier → row).
const cache = new Map<string, ProviderConnectionRow>();

function scopeKey(provider: string, tier: string): string {
  return `${provider}#${(tier || 'FREE').toUpperCase()}`;
}

function parseKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((k) => typeof k === 'string' && k.trim() !== '').map((k) => k.trim());
  } catch {
    return [];
  }
}

function parseLimitBlock(raw: string | null | undefined): RateLimitBlock {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') return o as RateLimitBlock;
  } catch { /* fall through */ }
  return {};
}

function rowToConn(row: any): ProviderConnectionRow {
  return {
    provider: row.provider,
    tier: (row.tier as ProviderTier) || 'FREE',
    label: row.label || '',
    baseUrl: row.baseUrl,
    baseUrlRoot: row.baseUrlRoot || null,
    apiKeys: parseKeys(row.apiKeys),
    apiLimit: parseLimitBlock(row.apiLimit),
    carrierLimit: parseLimitBlock(row.carrierLimit),
    enabled: row.enabled !== false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------- URL derivation（完整 URL，不再拼接） ----------------

/** 由完整 chat/completions URL 推导出「拉取模型列表」的 /models 端点。 */
export function modelsEndpointFromFullUrl(fullUrl: string): string {
  const u = String(fullUrl || '').trim();
  const stripped = u.replace(/\/chat\/completions\/?$/, '');
  if (stripped !== u) return `${stripped}/models`;
  // 无 /chat/completions 后缀：去掉最后一段路径再拼 /models（如 https://x/v1 → https://x/models）
  const basePath = u.replace(/\/[^/]*\/?$/, '');
  return `${basePath}models`;
}

/** chat/completions 的调用地址：完整 URL 原样返回（不再拼接）。 */
export function completionsEndpoint(fullUrl: string): string {
  return String(fullUrl || '').trim().replace(/\/+$/, '');
}

// ---------------- Base URL resolution ----------------

function applyToBaseUrlMap(conn: ProviderConnectionRow): void {
  // 仅 OpenAI 协议家族写回 PROVIDER_BASE_URLS（供 legacy 拼接调用点过渡用）；
  // 主调用链改为直接 POST 到 conn.baseUrl（见 chatCompletionUrlFor）。
  if (conn.tier === 'FREE') {
    (PROVIDER_BASE_URLS as Record<string, string>)[conn.provider] = conn.baseUrl;
  }
  if (conn.provider === 'agnes' && conn.tier === 'FREE') {
    const root = conn.baseUrlRoot || conn.baseUrl.replace(/\/v1\/?chat\/?completions\/?$/, '').replace(/\/v1\/?$/, '');
    (PROVIDER_BASE_URLS as any).agnesRoot = root;
  }
}

export function getProviderBaseUrl(provider: string, tier: ProviderTier = 'FREE'): string | undefined {
  const conn = cache.get(scopeKey(provider, tier));
  if (conn?.enabled) return conn.baseUrl;
  const hardcoded = (PROVIDER_BASE_URLS as Record<string, string>)[provider];
  return hardcoded;
}

/** 直接返回某供应商+tier 的完整调用 URL（不再拼接 /chat/completions）。 */
export function chatCompletionUrlFor(provider: string, tier: ProviderTier = 'FREE'): string | undefined {
  const conn = cache.get(scopeKey(provider, tier));
  if (conn?.enabled && conn.baseUrl) return completionsEndpoint(conn.baseUrl);
  // legacy base 拼接兜底（老部署）
  const base = (PROVIDER_BASE_URLS as Record<string, string>)[provider];
  if (base) return `${base.replace(/\/+$/, '')}/chat/completions`;
  return undefined;
}

export function getProviderConnections(tier?: ProviderTier): ProviderConnectionRow[] {
  const all = [...cache.values()];
  return tier ? all.filter((c) => c.tier === tier) : all;
}

export function getProviderConnection(provider: string, tier: ProviderTier): ProviderConnectionRow | undefined {
  return cache.get(scopeKey(provider, tier));
}

// ---------------- Load / seed ----------------

function legacyEnvKeys(provider: string): string[] {
  const prefix = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const keys: string[] = [];
  let i = 1;
  while (i <= 200) {
    const k = process.env[`${prefix}_API_KEY_${i}`]?.trim();
    if (k) keys.push(k); else if (i > 3) break; // 允许大量 key；无 key 时提前结束
    i++;
  }
  const legacy = process.env[`${prefix}_API_KEY`]?.trim();
  if (legacy && !keys.includes(legacy)) keys.push(legacy);
  return [...new Set(keys)];
}

function legacyEnvBaseUrl(provider: string): string | undefined {
  if (provider === 'xiaomi') return process.env.MIMO_BASE_URL?.trim() || undefined;
  if (provider === 'agnes') return process.env.AGNES_BASE_URL?.trim() || undefined;
  return undefined;
}

export async function loadProviderConfigs(): Promise<void> {
  const rows = await prismaUser.providerConnection.findMany();
  cache.clear();
  let seeded = false;

  for (const row of rows.map(rowToConn)) {
    cache.set(scopeKey(row.provider, row.tier), row);
    applyToBaseUrlMap(row);
  }

  // Seed known families missing from the DB from env (one-time bridge, FREE tier).
  for (const provider of Object.keys(PROVIDER_CATEGORIES)) {
    if (cache.has(scopeKey(provider, 'FREE'))) continue;
    const keys = legacyEnvKeys(provider);
    if (keys.length === 0) continue;
    const baseUrl = legacyEnvBaseUrl(provider) || (PROVIDER_BASE_URLS as Record<string, string>)[provider] || '';
    if (!baseUrl) continue;
    const created = await prismaUser.providerConnection.create({
      data: {
        provider,
        tier: 'FREE',
        label: PROVIDER_CATEGORIES[provider]?.label || provider,
        baseUrl,
        baseUrlRoot: null,
        apiKeys: JSON.stringify(keys),
        enabled: true,
      },
    });
    const conn = rowToConn(created);
    cache.set(scopeKey(provider, conn.tier), conn);
    applyToBaseUrlMap(conn);
    seeded = true;
    log('INFO', 'ProviderConfig', `seeded ${provider} (FREE) from env (${keys.length} keys)`);
  }

  if (seeded) {
    log('INFO', 'ProviderConfig', 'env → DB seed done; deployment env vars can now be removed');
  }
  log('INFO', 'ProviderConfig', `loaded ${cache.size} provider connection(s)`);
}

// ---------------- CRUD (admin API) ----------------

export interface UpsertConnectionInput {
  provider: string;
  tier: ProviderTier;
  label?: string;
  /** 完整 URL（chat/completions 端点，不再拼接） */
  baseUrl: string;
  baseUrlRoot?: string | null;
  /** 无数量上限 */
  apiKeys: string[];
  apiLimit?: RateLimitBlock;
  carrierLimit?: RateLimitBlock;
  enabled?: boolean;
}

export async function upsertProviderConnection(input: UpsertConnectionInput): Promise<ProviderConnectionRow> {
  const provider = String(input.provider).trim();
  if (!provider) throw new Error('provider 必填');
  if (!/^[\w-]{1,40}$/.test(provider)) throw new Error('provider 只能包含字母/数字/-/_（≤40 字符）');
  const tier: ProviderTier = input.tier === 'PRO' ? 'PRO' : 'FREE';
  const baseUrl = String(input.baseUrl).trim();
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('baseUrl 必须以 http(s):// 开头');
  const apiKeys = (input.apiKeys || []).map((k) => String(k).trim()).filter(Boolean); // 无上限
  const sk = scopeKey(provider, tier);

  const data = {
    label: input.label?.trim() || provider,
    baseUrl,
    baseUrlRoot: input.baseUrlRoot?.trim() || null,
    apiKeys: JSON.stringify(apiKeys),
    apiLimit: JSON.stringify(input.apiLimit || {}),
    carrierLimit: JSON.stringify(input.carrierLimit || {}),
    enabled: input.enabled !== false,
  };

  const existing = await prismaUser.providerConnection.findFirst({ where: { provider, tier } });
  if (existing) {
    await prismaUser.providerConnection.updateMany({ where: { provider, tier }, data });
    const saved = await prismaUser.providerConnection.findFirstOrThrow({ where: { provider, tier } });
    const conn = rowToConn(saved);
    cache.set(sk, conn);
    applyToBaseUrlMap(conn);
    return conn;
  }
  const created = await prismaUser.providerConnection.create({ data: { provider, tier, ...data } });
  const conn = rowToConn(created);
  cache.set(sk, conn);
  applyToBaseUrlMap(conn);
  // key 池重建由调用方（admin 路由）触发 apiKeyPool.rebuildApiKeyPools()
  return conn;
}

export async function deleteProviderConnection(provider: string, tier: ProviderTier = 'FREE'): Promise<void> {
  const sk = scopeKey(provider, tier);
  await prismaUser.providerConnection
    .deleteMany({ where: { provider, tier } })
    .catch(() => undefined);
  cache.delete(sk);
  if (tier === 'FREE') delete (PROVIDER_BASE_URLS as Record<string, string>)[provider];
}

export async function listProviderConnections(): Promise<ProviderConnectionRow[]> {
  return getProviderConnections();
}

// ---------------- 拉取列表 (fetch model list from a full URL) ----------------

const LIST_FETCH_TIMEOUT_MS = 15_000;

export interface FetchedModelRow {
  id: string;
  name?: string;
  pricing?: Record<string, number | null>;
}

// OpenAI 兼容 GET {modelsEndpoint} 优先；Google 原生 listing 兜底。
export async function fetchProviderModelList(baseUrl: string, apiKey?: string): Promise<FetchedModelRow[]> {
  const modelsUrl = modelsEndpointFromFullUrl(baseUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const tryOpenAi = async (): Promise<FetchedModelRow[] | null> => {
    try {
      const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(LIST_FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      const data: any = await res.json();
      const rows: any[] = Array.isArray(data) ? data : (data.data ?? []);
      if (!rows.length) return [];
      return rows.map((r) => ({
        id: String(r.id ?? r.name ?? '').trim(),
        name: r.name ? String(r.name) : undefined,
        pricing: r.pricing ?? undefined,
      })).filter((m) => m.id);
    } catch {
      return null;
    }
  };

  const openaiShape = await tryOpenAi();
  if (openaiShape !== null) return openaiShape;

  // Google-native fallback
  const root = /generativelanguage\.googleapis\.com/i.test(baseUrl)
    ? baseUrl
    : baseUrl.replace(/\/v1beta?$/, '');
  try {
    const res = await fetch(`${root}/models`, {
      headers: { ...headers, ...(apiKey ? { 'x-goog-api-key': apiKey } : {}) },
      signal: AbortSignal.timeout(LIST_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const rows: any[] = data.models ?? [];
    return rows
      .map((m) => ({ id: String(m.name ?? '').replace(/^models\//, '').trim() }))
      .filter((m: FetchedModelRow) => m.id);
  } catch (err: any) {
    throw new Error(`拉取列表失败：OpenAI 与 Google 两种格式均不可用（${err?.message || 'network'}）`);
  }
}
