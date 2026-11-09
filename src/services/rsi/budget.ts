// ================================================================
// 预算与冷却：复用 evolutionBudget（自然日计数 + 系统池），
// 并为 RSI 增加独立的每日上限，避免与既有进化预算互相抽干。
// ================================================================

import { prismaKnowledge } from '../db';

let memDay: string | null = null;
let memCount = 0;

function today(): string { return new Date().toISOString().slice(0, 10); }

/** RSI 当日候选计数（进程内 + DB 双源，取大者；DB 不可用时用进程内值 fail-closed）。 */
export async function todayCount(): Promise<number> {
  const d = today();
  if (memDay !== d) { memDay = d; memCount = 0; }
  try {
    const rows = await prismaKnowledge.evolutionAudit.count({
      where: { action: 'change_created', createdAt: { gte: new Date(`${d}T00:00:00.000Z`) } },
    });
    return Math.max(rows, memCount);
  } catch {
    return memCount;
  }
}

export async function incrementLocal(): Promise<void> {
  const d = today();
  if (memDay !== d) { memDay = d; memCount = 0; }
  memCount++;
}

/** 每日预算（含 DB 优先）；budget 表已存在 EvolutionBudget。 */
export async function systemPool(): Promise<{ total: number; used: number } | null> {
  try {
    const d = new Date().toISOString().slice(0, 10);
    const row = await prismaKnowledge.evolutionBudget.findUnique({ where: { date: d } });
    return row ? { total: row.systemPoolTotal ?? 10000, used: row.systemPoolUsed ?? 0 } : null;
  } catch {
    return null;
  }
}
