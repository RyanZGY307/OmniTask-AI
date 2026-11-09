// ================================================================
// SystemPause — 分级暂停 + 全局紧急环境变量兜底。
// 铁律：DB 不可用或暂停状态无法确认时，自动写入必须 fail-closed。
// ================================================================

import { prismaKnowledge } from '../db';
import { isPauseAllWrites } from './types';

export type PauseScope = 'global' | 'asset_type' | 'asset_key' | 'worker_kind';
export type PauseLevel = 'read' | 'write' | 'all';

export interface PauseCheckInput {
  scope: PauseScope;
  resource: string;        // '*':global, assetType, assetKey, worker kind
  level: PauseLevel;
}

export interface PauseVerdict { paused: boolean; unknown?: boolean; reason?: string; pauseId?: string }

/** 进程内缓存：DB 抖动时不清缓存为「未暂停」，而是判 unknown → 调用方 fail-closed。 */
let cache: { rows: Array<{ id: string; scope: string; resource: string; level: string; expiresAt: Date | null }>; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 3000;

export function invalidatePauseCache(): void { cache = null; }

export async function checkPause(input: PauseCheckInput): Promise<PauseVerdict> {
  // 1) 紧急环境变量最高优先（不经 DB）
  if (isPauseAllWrites() && input.level !== 'read') {
    return { paused: true, reason: 'PAUSE_ALL_WRITES=1' };
  }
  // 2) 全局暂停
  const want = input.level ?? 'write';
  if (await isPaused('global', '*', want)) return { paused: true, reason: 'global_paused' };
  if (input.scope !== 'global' && (await isPaused(input.scope, input.resource, want))) {
    return { paused: true, reason: `${input.scope}_paused:${input.resource}` };
  }
  return { paused: false };
}

/** level 语义：row.level='read' 只挡读；'write' 只挡写；'all' 两者都挡。 */
export function levelBlocks(rowLevel: string, wantLevel: PauseLevel): boolean {
  const r = String(rowLevel ?? 'all');
  if (r === 'all') return true;
  return r === wantLevel;
}

async function isPaused(scope: string, resource: string, wantLevel: PauseLevel = 'write'): Promise<boolean> {
  const rows = await loadRows();
  if (rows === null) {
    // 无法确认 → 视为暂停（write fail-closed）
    throw new Error('pause_state_unknown');
  }
  return rows.some((r) => r.scope === scope && r.resource === resource
    && levelBlocks(r.level, wantLevel)
    && (!r.expiresAt || r.expiresAt.getTime() > Date.now()));
}

async function loadRows() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.rows;
  try {
    const rows = await prismaKnowledge.systemPause.findMany({
      where: { resumedAt: null },
      select: { id: true, scope: true, resource: true, level: true, expiresAt: true },
    });
    cache = { rows, fetchedAt: Date.now() };
    return rows;
  } catch {
    cache = null;
    return null; // 触发 fail-closed
  }
}

export async function pause(input: {
  scope: PauseScope; resource: string; level: PauseLevel; pausedBy: string; reason: string; expiresAt?: Date;
}) {
  const row = await prismaKnowledge.systemPause.create({
    data: {
      scope: input.scope,
      resource: input.resource,
      level: input.level,
      pausedBy: input.pausedBy,
      reason: input.reason.slice(0, 300),
      expiresAt: input.expiresAt ?? null,
    },
  });
  invalidatePauseCache();
  return row;
}

export async function resume(pauseId: string): Promise<void> {
  await prismaKnowledge.systemPause.update({ where: { id: pauseId }, data: { resumedAt: new Date() } });
  invalidatePauseCache();
}

/** 过期暂停自动恢复（定时任务调用）。 */
export async function expireOverduePauses(): Promise<number> {
  const now = new Date();
  const due = await prismaKnowledge.systemPause.findMany({ where: { resumedAt: null, expiresAt: { lte: now } } });
  for (const p of due) await resume(p.id);
  return due.length;
}

/** 供 worker claim 使用：worker_kind 级暂停。 */
export async function isWorkerPaused(kind: string): Promise<boolean> {
  if (isPauseAllWrites()) return true;
  const rows = await loadRows();
  if (rows === null) throw new Error('pause_state_unknown');
  const live = (r: { expiresAt: Date | null }) => !r.expiresAt || r.expiresAt.getTime() > Date.now();
  if (rows.some((r) => r.scope === 'global' && r.resource === '*' && levelBlocks(r.level, 'write') && live(r))) return true;
  return rows.some((r) => r.scope === 'worker_kind' && r.resource === kind && levelBlocks(r.level, 'write') && live(r));
}
