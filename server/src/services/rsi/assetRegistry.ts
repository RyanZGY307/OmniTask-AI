// ================================================================
// ManagedAsset / AssetVersion 读写层（追加式版本，历史不可覆盖）。
// DB 访问集中在少数函数，其余为纯逻辑。
// ================================================================

import { prismaKnowledge, prismaUser } from '../db';
import { redact } from '../observability/pgStats';

export type AssetStatus = 'active' | 'paused' | 'quarantined' | 'retired';

export interface RegisterResult { id: string; created: boolean; currentVersion: number }

/** 注册或取得资产；assetKey 全局唯一。 */
export async function registerAsset(input: {
  assetType: string;
  assetKey: string;
  ownerId?: string | null;
  scope?: string;
  region?: string;
  actorKind: string;
  actorId: string;
}): Promise<RegisterResult> {
  const existing = await prismaKnowledge.managedAsset.findUnique({
    where: { assetType_assetKey: { assetType: input.assetType, assetKey: input.assetKey } },
  });
  if (existing) return { id: existing.id, created: false, currentVersion: existing.currentVersion };
  const row = await prismaKnowledge.managedAsset.create({
    data: {
      assetType: input.assetType,
      assetKey: input.assetKey,
      ownerId: input.ownerId ?? null,
      scope: input.scope ?? (input.ownerId ? 'user' : 'global'),
      region: input.region ?? null,
      currentVersion: 0,
      status: 'active',
    },
  });
  return { id: row.id, created: true, currentVersion: 0 };
}

export async function getAssetByKey(assetKey: string) {
  return prismaKnowledge.managedAsset.findFirst({ where: { assetKey } });
}

export async function getAsset(assetType: string, assetKey: string) {
  return prismaKnowledge.managedAsset.findUnique({
    where: { assetType_assetKey: { assetType, assetKey } },
  });
}

/** 追加新版本：内容脱敏后入库，返回新版本号。 */
export async function createVersion(input: {
  assetType: string;
  assetKey: string;
  content: string;
  contentRef?: string;
  actorKind: string;
  actorId: string;
  maxInlineLen?: number;
}): Promise<{ version: number; versionId: string; contentHash: string }> {
  const asset = await prismaKnowledge.managedAsset.findUnique({
    where: { assetType_assetKey: { assetType: input.assetType, assetKey: input.assetKey } },
  });
  if (!asset) throw new Error('asset_not_registered');
  if (asset.status === 'retired' || asset.status === 'quarantined') throw new Error(`asset_${asset.status}`);

  const version = asset.currentVersion + 1;
  const raw = redact(input.content).text;
  const hash = hash16(raw);
  const inline = typeof input.maxInlineLen === 'number' ? input.maxInlineLen : 8000;
  const row = await prismaKnowledge.assetVersion.create({
    data: {
      assetKey: input.assetKey,
      version,
      contentRef: input.contentRef ?? `${input.assetType}:${input.assetKey}`,
      contentHash: hash,
      content: raw.length <= inline ? raw : null,
      status: 'quarantined',
      createdBy: input.actorId,
      actorKind: input.actorKind,
    },
  });
  await prismaKnowledge.managedAsset.update({
    where: { id: asset.id },
    data: { currentVersion: version },
  });
  return { version, versionId: row.id, contentHash: hash };
}

export function hash16(text: string): string {
  // FNV-1a 32bit → 8 hex；再叠一次长度指纹到 16 位
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const l = (text.length >>> 0).toString(16).padStart(4, '0');
  return h.toString(16).padStart(8, '0') + l;
}

export async function getCurrentVersion(assetKey: string) {
  const asset = await prismaKnowledge.managedAsset.findFirst({ where: { assetKey } });
  if (!asset || asset.currentVersion === 0) return null;
  return prismaKnowledge.assetVersion.findUnique({
    where: { assetKey_version: { assetKey, version: asset.currentVersion } },
  });
}

export async function listVersions(assetKey: string, limit = 20) {
  return prismaKnowledge.assetVersion.findMany({
    where: { assetKey },
    orderBy: { version: 'desc' },
    take: Math.min(limit, 50),
  });
}

/** publish：旧 released → superseded，新版本 → released（回滚同样走这里，产生反向新版本）。 */
export async function releaseVersion(assetKey: string, version: number): Promise<void> {
  const target = await prismaKnowledge.assetVersion.findUnique({ where: { assetKey_version: { assetKey, version } } });
  if (!target) throw new Error('version_not_found');
  await prismaKnowledge.$transaction([
    prismaKnowledge.assetVersion.updateMany({
      where: { assetKey, status: 'released' },
      data: { status: 'superseded' },
    }),
    prismaKnowledge.assetVersion.update({ where: { id: target.id }, data: { status: 'released' } }),
  ]);
}

/** 上一个 released 版本（回滚目标）；不存在返回 null。 */
export async function getPreviousReleasedVersion(assetKey: string): Promise<{ version: number; content: string | null; contentRef: string } | null> {
  const rows = await prismaKnowledge.assetVersion.findMany({
    where: { assetKey, status: { in: ['released', 'superseded'] } },
    orderBy: { version: 'desc' },
    take: 2,
  });
  // rows[0] 通常是当前 released；回滚目标是它之前的那个（superseded）
  const target = rows.find((r) => r.status === 'superseded') ?? (rows.length > 1 ? rows[1] : null);
  if (!target) return null;
  return { version: target.version, content: target.content, contentRef: target.contentRef };
}

/** 读取发布内容：content 为 null 时退回 contentRef（大内容外置场景）。 */
export async function resolveReleasedContent(assetKey: string): Promise<{ version: number; content: string; contentRef: string } | null> {
  const cur = await getCurrentVersion(assetKey);
  if (!cur || cur.status !== 'released') return null;
  return { version: cur.version, content: cur.content ?? cur.contentRef, contentRef: cur.contentRef };
}
