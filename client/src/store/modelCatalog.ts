'use client';
// ================================================================
// Model catalog store — 用户端「模型选择」的唯一数据源（GET /api/models）。
//
// 模型列表与积分由 admin 在 /admin/models 录入（ModelConfig 表），
// 经后端按用户 tier 过滤 + 厂商分组 + 去前缀显示名 + 分页下发。
// 本 store 抓取实时目录；硬编码清单已清空，API 不可达时列表为空。
// ================================================================

import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';

export interface CatalogModel {
  key: string;
  provider: string;
  apiModel: string;
  displayName: string;
  vendor?: string;
  tier: 'FREE' | 'PRO';
  category?: string;
  costPer1k: number;
  maxTokens?: number;
  contextWindow?: number;
  /** 负载：ok | hot（调用量高）| busy（需排队）| blocked（暂不可用） */
  load?: 'ok' | 'hot' | 'busy' | 'blocked';
}

export interface VendorGroup {
  vendor: string;
  label: string;
  costLabel: '免费' | '消耗积分';
  keys: string[];
  models: CatalogModel[];
  defaultKey?: string;
  load?: 'ok' | 'hot' | 'busy' | 'blocked';
}

export interface CatalogList {
  models: CatalogModel[]; // 平铺（已分页）
  all: CatalogModel[];    // 全量 tier 过滤后 LLM
  groups: VendorGroup[];  // 后端厂商分组（A→Z）
  pageSize: number;
  loaded: boolean;
  updatedAt: number | null;
  /** 后端默认选中项（quality-based，与 routeModel 未选择时的兜底一致） */
  defaultKey?: string | null;
}

function empty(): CatalogList {
  return { models: [], all: [], groups: [], pageSize: 10, loaded: false, updatedAt: null, defaultKey: null };
}

let cached: CatalogList | null = null;
const subscribers = new Set<() => void>();

function notify() {
  for (const fn of subscribers) {
    try { fn(); } catch {}
  }
}

export function subscribeModelCatalog(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

// 并发调用合并为一次请求。
let inFlight: Promise<void> | null = null;

export async function refreshModelCatalog(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const data: any = await apiGet('/models');
      const all: CatalogModel[] = (Array.isArray(data?.all) ? data.all : Array.isArray(data?.models) ? data.models : [])
        .map((m: any) => ({
          key: String(m.key),
          provider: m.provider,
          apiModel: m.apiModel,
          displayName: m.displayName,
          vendor: m.vendor,
          tier: m.tier === 'PRO' ? 'PRO' : 'FREE',
          category: m.category,
          costPer1k: m.costPer1k ?? 0,
          maxTokens: m.maxTokens,
          contextWindow: m.contextWindow,
          load: m.load || 'ok',
        }));
      const groups: VendorGroup[] = Array.isArray(data?.groups) ? data.groups : [];
      const paged = Array.isArray(data?.models) ? data.models : all;
      cached = {
        models: paged,
        all,
        groups,
        pageSize: data?.pageSize ?? 10,
        loaded: all.length > 0,
        defaultKey: data?.defaultKey ?? null,
        updatedAt: Date.now(),
      };
    } catch {
      cached = cached ?? empty();
    } finally {
      notify();
      inFlight = null;
    }
  })();
  return inFlight;
}

export function useModelCatalog(): CatalogList {
  const [, force] = useState(0);
  useEffect(() => {
    if (!cached) refreshModelCatalog();
    const unsub = subscribeModelCatalog(() => force((n) => n + 1));
    return unsub;
  }, []);

  return cached ?? empty();
}
