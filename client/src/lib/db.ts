// ================================================================
// Frontend data layer — 只读 client，数据全部经由后端 API
// ================================================================
// 前端不直连数据库：所有读写都走后端（/models、/currency 等），
// 数据库访问由服务端独占（只读 server）。

import { apiGet, apiPut, apiPost } from './api';

export interface ModelLimitRow {
  modelId: string;
  version: string | null;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
  contextWindow: number | null;
  source: string;
  status: string;
  verifiedAt: string;
}

export interface ExchangeRateRow {
  currency: string;
  rate: number;
  updatedAt: string;
}

// ---- Reads (全部经后端) ----

export async function fetchModelLimits(): Promise<ModelLimitRow[]> {
  try {
    const res = await apiGet('/models/limits');
    return Array.isArray(res) ? res : res?.limits ?? [];
  } catch {
    // 后端未开放该端点时返回空，避免前端直连数据库的旧行为
    return [];
  }
}

export async function fetchExchangeRates(): Promise<ExchangeRateRow[]> {
  try {
    const res = await apiGet('/currency/rates');
    return Array.isArray(res) ? res : res?.rates ?? [];
  } catch {
    return [];
  }
}

// ---- Writes (全部经后端) ----

export async function upsertModelLimit(row: Partial<ModelLimitRow> & { modelId: string }) {
  return apiPut('/models/limits', row);
}

export async function upsertExchangeRate(row: { currency: string; rate: number }) {
  return apiPost('/currency/rates', row);
}
