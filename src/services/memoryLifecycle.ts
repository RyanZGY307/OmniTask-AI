// ================================================================
// Memory Lifecycle — State transitions, stale detection, cleanup
// ================================================================

import { prisma } from './db';

const VALID_TRANSITIONS: Record<string, string[]> = {
  observed:   ['candidate', 'archived', 'deleted'],
  candidate:  ['validating', 'active', 'archived', 'deleted'],
  validating: ['active', 'stale', 'archived', 'deleted'],
  active:     ['reinforced', 'stale', 'superseded', 'archived', 'deleted'],
  reinforced: ['stale', 'superseded', 'archived', 'deleted'],
  stale:      ['active', 'archived', 'deleted'],
  superseded: ['archived', 'deleted'],
  archived:   ['deleted'],
};

export async function transitionState(
  memoryId: string,
  newState: string,
  reason?: string,
): Promise<boolean> {
  const mem = await prisma.longTermMemory.findUnique({ where: { id: memoryId } });
  if (!mem) return false;

  const allowed = VALID_TRANSITIONS[mem.status] || [];
  if (!allowed.includes(newState)) {
    console.warn(`[MemoryLifecycle] Invalid transition: ${mem.status} → ${newState}`);
    return false;
  }

  await prisma.longTermMemory.update({
    where: { id: memoryId },
    data: { status: newState, updatedAt: new Date() },
  });

  await prisma.memoryEvent.create({
    data: {
      memoryId,
      eventType: newState === 'superseded' ? 'superseded' : newState === 'stale' ? 'stale_detected' : newState === 'archived' ? 'archived' : 'created',
      detail: reason || `${mem.status} → ${newState}`,
    },
  }).catch(() => {});

  return true;
}

export async function runStaleDetection(userId: string): Promise<number> {
  let staleCount = 0;
  const now = new Date();

  try {
    // Preferences not confirmed in 60 days
    const stalePrefs = await prisma.userPreference.findMany({
      where: {
        userId,
        status: 'active',
        OR: [
          { lastConfirmedAt: null, lastObservedAt: { lt: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000) } },
          { lastConfirmedAt: { lt: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000) } },
        ],
      },
    });
    for (const pref of stalePrefs) {
      await prisma.userPreference.update({ where: { id: pref.id }, data: { status: 'archived' } });
      staleCount++;
    }

    // Habits not observed in 30 days → stale
    const staleHabits = await prisma.userHabit.findMany({
      where: {
        userId,
        status: 'active',
        lastObservedAt: { lt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
      },
    });
    for (const habit of staleHabits) {
      await prisma.userHabit.update({ where: { id: habit.id }, data: { status: 'stale' } });
      staleCount++;
    }

    // Long-term memories with low freshness
    const staleMems = await prisma.longTermMemory.findMany({
      where: {
        userId,
        status: { in: ['active', 'candidate', 'validating'] },
        lastObservedAt: { lt: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) },
      },
    });
    for (const mem of staleMems) {
      const decayedFreshness = Math.max(0, mem.freshness - 0.2);
      if (decayedFreshness < 0.2) {
        await prisma.longTermMemory.update({ where: { id: mem.id }, data: { status: 'stale', freshness: 0 } });
        staleCount++;
      } else {
        await prisma.longTermMemory.update({ where: { id: mem.id }, data: { freshness: decayedFreshness } });
      }
    }

    // Domain profiles — decay freshness
    const domains = await prisma.domainProfile.findMany({
      where: { userId, lastObservedAt: { lt: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) } },
    });
    for (const d of domains) {
      await prisma.domainProfile.update({
        where: { id: d.id },
        data: { freshness: Math.max(0, d.freshness - 0.1) },
      });
    }

    // Interest decay
    const interests = await prisma.userInterest.findMany({
      where: { userId, status: 'active', lastObservedAt: { lt: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000) } },
    });
    for (const interest of interests) {
      const newStrength = interest.strength - 0.1;
      if (newStrength < 0.1) {
        await prisma.userInterest.update({ where: { id: interest.id }, data: { status: 'decayed', strength: 0 } });
      } else {
        await prisma.userInterest.update({ where: { id: interest.id }, data: { strength: newStrength } });
      }
    }

  } catch (err) {
    console.error('[MemoryLifecycle] staleDetection error:', err);
  }

  return staleCount;
}

export async function cleanup(userId: string, maxAgeDays = 180): Promise<number> {
  let cleaned = 0;
  try {
    // Archive stale memories older than maxAge
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    const toArchive = await prisma.longTermMemory.findMany({
      where: { userId, status: 'stale', updatedAt: { lt: cutoff } },
    });
    for (const mem of toArchive) {
      await prisma.longTermMemory.update({ where: { id: mem.id }, data: { status: 'archived' } });
      cleaned++;
    }

    // Delete very old archived memories
    const veryOld = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const toDelete = await prisma.longTermMemory.findMany({
      where: { userId, status: 'archived', updatedAt: { lt: veryOld } },
    });
    for (const mem of toDelete) {
      await prisma.longTermMemory.delete({ where: { id: mem.id } });
      cleaned++;
    }
  } catch (err) {
    console.error('[MemoryLifecycle] cleanup error:', err);
  }
  return cleaned;
}