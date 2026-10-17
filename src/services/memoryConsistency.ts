// ================================================================
// Memory Consistency — Conflict detection, resolution, validation
// ================================================================

import { prisma } from './db';

export interface Conflict {
  existingMemoryId: string;
  existingContent: string;
  newContent: string;
  type: 'contradiction' | 'supersession' | 'duplicate';
  resolution: 'duplicate' | 'keep_existing' | 'replace' | 'merge' | 'keep_both';
}

const SOURCE_PRIORITY: Record<string, number> = {
  user_explicit: 100,
  conversation: 60,
  file: 50,
  inference: 20,
};

export async function checkConflicts(
  userId: string,
  newType: string,
  newContent: string,
  newSourceType?: string,
): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];

  try {
    // Find active memories of same type
    const existing = await prisma.longTermMemory.findMany({
      where: {
        userId,
        type: newType,
        status: { in: ['active', 'reinforced', 'candidate', 'validating'] },
      },
      take: 20,
    });

    for (const mem of existing) {
      const similarity = computeSimilarity(newContent, mem.content);

      if (similarity > 0.8) {
        // High similarity — likely duplicate or update
        const newPriority = SOURCE_PRIORITY[newSourceType || 'inference'] || 10;
        const existingPriority = SOURCE_PRIORITY[mem.sourceType || 'inference'] || 10;

        let resolution: Conflict['resolution'] = 'keep_both';
        if (similarity > 0.95) {
          resolution = 'duplicate'; // will reinforce existing
        } else if (newPriority > existingPriority) {
          resolution = 'replace';
        } else if (newPriority === existingPriority) {
          resolution = 'merge';
        }

        conflicts.push({
          existingMemoryId: mem.id,
          existingContent: mem.content,
          newContent,
          type: similarity > 0.95 ? 'duplicate' : 'supersession',
          resolution,
        });
      } else if (similarity > 0.4 && areContradictory(mem.content, newContent)) {
        conflicts.push({
          existingMemoryId: mem.id,
          existingContent: mem.content,
          newContent,
          type: 'contradiction',
          resolution: (SOURCE_PRIORITY[newSourceType || 'inference'] || 10) > (SOURCE_PRIORITY[mem.sourceType || 'inference'] || 10)
            ? 'replace' : 'keep_existing',
        });
      }
    }
  } catch (err) {
    console.error('[MemoryConsistency] checkConflicts error:', err);
  }

  return conflicts;
}

export async function resolveConflict(
  conflict: Conflict,
  userId: string,
  newMemoryFn: () => Promise<string | null>,
): Promise<{ action: string; memoryId: string | null }> {
  switch (conflict.resolution) {
    case 'duplicate':
      // Reinforce existing
      await prisma.longTermMemory.update({
        where: { id: conflict.existingMemoryId },
        data: {
          evidenceCount: { increment: 1 },
          confidence: { increment: 0.03 },
          freshness: 1.0,
          lastConfirmedAt: new Date(),
          lastObservedAt: new Date(),
        },
      });
      await logEvent(conflict.existingMemoryId, 'evidence_added', 'Duplicate detected, reinforcing');
      return { action: 'reinforced', memoryId: conflict.existingMemoryId };

    case 'replace':
      const newId = await newMemoryFn();
      if (newId) {
        await prisma.longTermMemory.update({
          where: { id: conflict.existingMemoryId },
          data: { status: 'superseded', supersededBy: newId },
        });
        await logEvent(conflict.existingMemoryId, 'superseded', `Replaced by ${newId}`);
      }
      return { action: 'replaced', memoryId: newId };

    case 'keep_existing':
      await logEvent(conflict.existingMemoryId, 'conflict_resolved', 'Kept existing, rejected new');
      return { action: 'kept_existing', memoryId: conflict.existingMemoryId };

    case 'merge':
    case 'keep_both':
    default:
      const mergedId = await newMemoryFn();
      return { action: 'kept_both', memoryId: mergedId };
  }
}

export function validateMemory(data: { content: string; type: string; userId: string }): { valid: boolean; reason?: string } {
  if (!data.content || data.content.trim().length < 3) {
    return { valid: false, reason: 'Content too short' };
  }
  if (data.content.length > 5000) {
    return { valid: false, reason: 'Content too long for memory' };
  }
  if (!data.type) {
    return { valid: false, reason: 'Type required' };
  }
  // Check for PII patterns (basic)
  if (/\b\d{16,19}\b/.test(data.content)) {
    return { valid: false, reason: 'Possible card number detected' };
  }
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(data.content) && data.type !== 'conversation_fact') {
    return { valid: false, reason: 'Email address in non-fact memory' };
  }
  return { valid: true };
}

function computeSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  return intersection / Math.max(wordsA.size, wordsB.size);
}

function areContradictory(a: string, b: string): boolean {
  const negations = [
    [/喜欢/, /不喜欢/], [/要/, /不要/], [/是/, /不是/],
    [/prefer/, /don't prefer/], [/like/, /dislike/], [/yes/, /no/],
    [/开启/, /关闭/], [/enable/, /disable/],
  ];
  for (const [pos, neg] of negations) {
    if ((pos.test(a) && neg.test(b)) || (neg.test(a) && pos.test(b))) return true;
  }
  return false;
}

async function logEvent(memoryId: string, eventType: string, detail: string): Promise<void> {
  await prisma.memoryEvent.create({ data: { memoryId, eventType, detail } }).catch(() => {});
}