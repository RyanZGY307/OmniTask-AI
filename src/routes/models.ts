// ================================================================
// Model Registry API — 用户端「模型选择」数据源（admin 在 /admin/models
// 录入的 ModelConfig 为准，硬编码清单已不在此返回）。
//   GET /api/models          按用户 tier 过滤 + 厂商分组 + 去前缀显示名 + 分页
//   GET /api/models/:key
// ================================================================

import { Router, Response } from 'express';
import { getDynamicModels, vendorFor, strippedDisplayName } from '../services/configSync';
import { modelLoadStatus } from '../services/rateGate';
import { pickMostGeneralModelForUser, pickFastestModelForUser } from '../services/router';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

const PRICING_VERSION = '2026-09';
// 厂商内模型列表的分页上限由后端设定（用户端一次渲染一屏），超出走 ?page=
const PAGE_SIZE = 10;
const MEDIA_CATEGORIES = new Set(['image', 'video', 'audio']);

// tier 层级：ULTRA 已并回 PRO
const TIER_INDEX: Record<string, number> = { STANDARD: 0, FREE: 0, PRO: 1, ULTRA: 1 };
function userTierIndex(user: any): number {
  return TIER_INDEX[user?.subscriptionTier] ?? 0;
}

router.get('/', authMiddleware, (req: AuthRequest, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query.page)) || 1);
  const userTierIdx = userTierIndex(req.user!);

  // LLM 可选手（媒体/音频不进选择器）+ 按用户 tier 过滤
  const all = Object.entries(getDynamicModels())
    .filter(([, e]) => !MEDIA_CATEGORIES.has(e.category))
    .filter(([, e]) => (TIER_INDEX[e.tier] ?? 0) <= userTierIdx)
    .filter(([, e]) => e.enabled && e.status === 'online');

  // 去前缀显示名 + 厂商（admin 手填 vendor 优先，否则按 provider 自动归类）+ 负载状态
  const models = all.map(([key, e]) => ({
    key,
    provider: e.provider,
    apiModel: e.apiModel,
    displayName: strippedDisplayName(e.apiModel, e.provider, e.displayName),
    vendor: vendorFor(e.provider, e.vendor),
    tier: e.tier,
    costPer1k: e.costPer1k,
    maxTokens: e.maxTokens,
    contextWindow: e.contextWindow,
    load: modelLoadStatus(key, e.provider, e.tier === 'PRO' ? 'PRO' : 'FREE'),
  }));

  // 厂商分组：按 vendor A→Z 排序；组内模型按显示名 A→Z
  const groupMap = new Map<string, typeof models>();
  for (const m of models) {
    const arr = groupMap.get(m.vendor) || [];
    arr.push(m);
    groupMap.set(m.vendor, arr);
  }
  const groups = [...groupMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([vendor, list]) => {
      const sorted = [...list].sort((a, b) => a.displayName.localeCompare(b.displayName));
      // 厂商组取组内最严重负载（blocked > busy > hot > ok）
      const sev: Record<string, number> = { ok: 0, hot: 1, busy: 2, blocked: 3 };
      let groupLoad: string = 'ok';
      for (const m of sorted) if ((sev[m.load as string] ?? 0) > (sev[groupLoad] ?? 0)) groupLoad = m.load as string;
      return {
        vendor,
        label: vendor,
        costLabel: sorted.every((m) => !m.costPer1k) ? '免费' : '消耗积分',
        keys: sorted.map((m) => m.key),
        models: sorted,
        defaultKey: sorted[0]?.key,
        load: groupLoad,
      };
    });

  // 平铺列表分页（厂商内渲染用；超 PAGE_SIZE 的部分经 ?page= 取）
  const pagedModels = models.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  res.json({
    models: pagedModels,
    all: models,
    groups,
    defaultKey: (userTierIdx === 0
      ? pickFastestModelForUser(req.user)
      : pickMostGeneralModelForUser(req.user)) || models[0]?.key || null,
    vendorCount: groups.length,
    page,
    pageSize: PAGE_SIZE,
    pricingVersion: PRICING_VERSION,
  });
});

router.get('/:key', authMiddleware, (req: AuthRequest, res: Response) => {
  const info = getDynamicModels()[String(req.params.key)];
  if (!info) { res.status(404).json({ error: 'Unknown model' }); return; }
  res.json({
    key: String(req.params.key),
    provider: info.provider,
    apiModel: info.apiModel,
    displayName: strippedDisplayName(info.apiModel, info.provider, info.displayName),
    vendor: vendorFor(info.provider, info.vendor),
    tier: info.tier,
    category: info.category,
    maxTokens: info.maxTokens,
    contextWindow: info.contextWindow,
    costPer1k: info.costPer1k,
    pricingVersion: PRICING_VERSION,
    enabled: info.enabled,
  });
});

export default router;
