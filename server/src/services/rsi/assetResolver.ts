// ================================================================
// 资产内容解析：生产版本 + 灰度分流。供管理页 /resolve 端点核对消费口径。
// ================================================================

import { getAssetByKey, resolveReleasedContent } from './assetRegistry';
import { stableBucket, inRollout } from './rollout';

export interface ResolveResult {
  assetKey: string;
  found: boolean;
  status?: string;
  currentVersion?: number;
  content?: string | null;
  contentRef?: string | null;
  rollout?: { inRollout: boolean; bucket: number };
}

/** 解析某资产对某调用方可见的内容：优先已发布版本；若处于灰度则按稳定分桶给出。 */
export async function resolveAssetContent(assetKey: string, actorId = 'anonymous'): Promise<ResolveResult> {
  const asset = await getAssetByKey(assetKey);
  if (!asset) return { assetKey, found: false };
  const rel = await resolveReleasedContent(assetKey);
  const bucket = stableBucket(`${actorId}:${assetKey}`);
  return {
    assetKey,
    found: true,
    status: asset.status,
    currentVersion: asset.currentVersion,
    content: rel?.content ?? null,
    contentRef: rel?.contentRef ?? null,
    rollout: { inRollout: inRollout(actorId, assetKey, 5), bucket },
  };
}
