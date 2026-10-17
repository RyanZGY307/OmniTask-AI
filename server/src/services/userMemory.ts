// ================================================================
// User Memory — Preferences, Requirements, Habits, Interests, Profile
// ================================================================

import { prisma } from './db';
import type { AdaptiveProfileData } from './responseCalibration';

// ==================== Adaptive Profile ====================

const DEFAULT_ADAPTIVE: AdaptiveProfileData = {
  communication: { detailLevel: 0.5, directness: 0.5, technicalDepth: 0.5, formality: 0.5 },
  format: { structuredAnswer: 0.5, useTables: 0.3, useMarkdown: 0.5, useBulletPoints: 0.4 },
  workflow: { compareBeforeDecide: 0.3, iterativeRefinement: 0.3, analysisFirst: 0.3 },
};

export async function getAdaptiveProfile(userId: string): Promise<AdaptiveProfileData> {
  try {
    const profile = await prisma.userProfile.findUnique({ where: { userId } });
    if (!profile || !profile.adaptiveProfile) {
      return DEFAULT_ADAPTIVE;
    }
    let p: any = {};
    try { p = JSON.parse(profile.adaptiveProfile); } catch { return DEFAULT_ADAPTIVE; }
    if (!p || typeof p !== 'object') return DEFAULT_ADAPTIVE;
    return {
      communication: { ...DEFAULT_ADAPTIVE.communication, ...p.communication },
      format: { ...DEFAULT_ADAPTIVE.format, ...p.format },
      workflow: { ...DEFAULT_ADAPTIVE.workflow, ...p.workflow },
    };
  } catch {
    return DEFAULT_ADAPTIVE;
  }
}

export async function updateAdaptiveProfile(userId: string, updates: Partial<AdaptiveProfileData>): Promise<void> {
  try {
    const existing = await prisma.userProfile.findUnique({ where: { userId } });
    let current: any = {};
    if (existing?.adaptiveProfile) {
      try { current = JSON.parse(existing.adaptiveProfile); } catch { current = {}; }
    }
    const merged = {
      communication: { ...DEFAULT_ADAPTIVE.communication, ...current.communication, ...updates.communication },
      format: { ...DEFAULT_ADAPTIVE.format, ...current.format, ...updates.format },
      workflow: { ...DEFAULT_ADAPTIVE.workflow, ...current.workflow, ...updates.workflow },
    };
    await prisma.userProfile.upsert({
      where: { userId },
      create: { userId, adaptiveProfile: JSON.stringify(merged) },
      update: { adaptiveProfile: JSON.stringify(merged), version: { increment: 1 } },
    });
  } catch (err) {
    console.error('[UserMemory] updateAdaptiveProfile error:', err);
  }
}

// ==================== Preferences ====================

export async function getPreferences(userId: string, category?: string): Promise<any[]> {
  try {
    const where: any = { userId, status: 'active' };
    if (category) where.category = category;
    return prisma.userPreference.findMany({
      where,
      orderBy: [{ confidence: 'desc' }, { lastObservedAt: 'desc' }],
      take: 20,
    });
  } catch { return []; }
}

export async function addPreference(
  userId: string,
  data: {
    type: 'positive' | 'negative';
    category: string;
    content: string;
    source?: string;
    strength?: number;
  },
): Promise<any> {
  // Check for duplicates
  const existing = await prisma.userPreference.findFirst({
    where: {
      userId,
      status: 'active',
      category: data.category,
      type: data.type,
      content: { contains: data.content.substring(0, 30) },
    },
  });

  if (existing) {
    // Reinforce existing
    return prisma.userPreference.update({
      where: { id: existing.id },
      data: {
        evidenceCount: { increment: 1 },
        confidence: Math.min(0.99, existing.confidence + 0.05),
        strength: Math.min(1, (existing.strength + (data.strength || 0.5)) / 2),
        lastObservedAt: new Date(),
        lastConfirmedAt: new Date(),
      },
    });
  }

  return prisma.userPreference.create({
    data: {
      userId,
      type: data.type,
      category: data.category,
      content: data.content,
      source: data.source || 'inferred',
      strength: data.strength || 0.5,
      confidence: data.source === 'explicit' ? 0.9 : 0.4,
    },
  });
}

export async function supersedePreference(oldId: string, newId: string): Promise<void> {
  await prisma.userPreference.update({ where: { id: oldId }, data: { status: 'superseded', supersededBy: newId } });
  await prisma.userPreference.update({ where: { id: newId }, data: { supersedes: oldId } });
}

// ==================== Requirements ====================

export async function getRequirements(userId: string): Promise<any[]> {
  try {
    return prisma.userRequirement.findMany({
      where: { userId, status: 'active' },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });
  } catch { return []; }
}

export async function addRequirement(
  userId: string,
  data: { category: string; content: string; priority?: string; source?: string },
): Promise<any> {
  // Check duplicate
  const existing = await prisma.userRequirement.findFirst({
    where: { userId, status: 'active', category: data.category, content: { contains: data.content.substring(0, 30) } },
  });
  if (existing) return existing;

  return prisma.userRequirement.create({
    data: {
      userId,
      category: data.category,
      content: data.content,
      priority: data.priority || 'normal',
      source: data.source || 'explicit',
    },
  });
}

// ==================== Habits ====================

export async function getActiveHabits(userId: string): Promise<any[]> {
  try {
    return prisma.userHabit.findMany({
      where: { userId, status: { in: ['active', 'validating'] } },
      orderBy: { confidence: 'desc' },
    });
  } catch { return []; }
}

export async function observeHabit(
  userId: string,
  data: { type: string; description: string },
): Promise<void> {
  try {
    const existing = await prisma.userHabit.findFirst({
      where: { userId, type: data.type, status: { in: ['candidate', 'validating', 'active'] } },
    });

    if (existing) {
      const newCount = existing.evidenceCount + 1;
      const newConfidence = Math.min(0.95, existing.confidence + 0.08);
      let newStatus = existing.status;

      if (existing.status === 'candidate' && newCount >= 3) newStatus = 'validating';
      if (existing.status === 'validating' && newCount >= 5 && newConfidence >= 0.5) newStatus = 'active';
      if (existing.status === 'active' && newCount >= 10 && newConfidence >= 0.8) newStatus = 'active'; // stays active, higher confidence

      await prisma.userHabit.update({
        where: { id: existing.id },
        data: { evidenceCount: newCount, confidence: newConfidence, status: newStatus, lastObservedAt: new Date() },
      });
    } else {
      await prisma.userHabit.create({
        data: {
          userId,
          type: data.type,
          description: data.description,
          confidence: 0.2,
          evidenceCount: 1,
          status: 'candidate',
        },
      });
    }
  } catch (err) {
    console.error('[UserMemory] observeHabit error:', err);
  }
}

// ==================== Interests ====================

export async function getInterests(userId: string, status = 'active'): Promise<any[]> {
  try {
    return prisma.userInterest.findMany({
      where: { userId, status },
      orderBy: { strength: 'desc' },
    });
  } catch { return []; }
}

export async function observeInterest(userId: string, domain: string, topic = '*'): Promise<void> {
  try {
    const existing = await prisma.userInterest.findUnique({
      where: { userId_domain_topic: { userId, domain, topic } },
    });

    if (existing) {
      await prisma.userInterest.update({
        where: { id: existing.id },
        data: {
          evidenceCount: { increment: 1 },
          strength: Math.min(1, existing.strength + 0.05),
          status: 'active',
          lastObservedAt: new Date(),
        },
      });
    } else {
      await prisma.userInterest.create({
        data: { userId, domain, topic, strength: 0.3, evidenceCount: 1 },
      });
    }
  } catch (err) {
    console.error('[UserMemory] observeInterest error:', err);
  }
}

// ==================== Memory Candidate Extraction ====================

export interface MemoryCandidate {
  type: 'preference' | 'requirement' | 'habit' | 'interest';
  data: any;
  confidence: number;
  source: 'explicit' | 'inferred';
}

const EXPLICIT_PATTERNS = [
  { regex: /以后(.*?)回答|以后(.*?)这样|从现在开始(.*?)/, type: 'preference', subtype: 'communication' },
  { regex: /不要(.*?)了|别(.*?)了|不需要(.*?)/, type: 'preference', subtype: 'negative' },
  { regex: /请记住|记住这个|不要忘|一直这样/, type: 'requirement', subtype: 'persistent' },
  { regex: /每次(.*?)都|总是(.*?)就好|默认(.*?)/, type: 'habit', subtype: 'default' },
];

export function extractMemoryCandidates(userMsg: string, assistantMsg: string): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const lower = userMsg.toLowerCase();

  // Explicit preference detection
  for (const pattern of EXPLICIT_PATTERNS) {
    const match = userMsg.match(pattern.regex);
    if (match) {
      if (pattern.type === 'requirement') {
        candidates.push({
          type: 'requirement',
          data: { category: 'interaction', content: userMsg.substring(0, 200), priority: 'high' },
          confidence: 0.85,
          source: 'explicit',
        });
      } else {
        candidates.push({
          type: 'preference',
          data: {
            type: pattern.subtype === 'negative' ? 'negative' : 'positive',
            category: pattern.subtype || 'communication',
            content: userMsg.substring(0, 200),
          },
          confidence: 0.8,
          source: 'explicit',
        });
      }
    }
  }

  // Correction detection → negative signal for assistant's approach
  const correctionWords = ['不对', '错了', '错了', '错误', '不是这样', '重新', '重来', 'wrong', 'incorrect', 'not right'];
  const isCorrection = correctionWords.some(w => lower.includes(w));
  if (isCorrection && userMsg.length < 200) {
    candidates.push({
      type: 'preference',
      data: { type: 'negative', category: 'communication', content: `用户纠正: ${userMsg.substring(0, 100)}` },
      confidence: 0.6,
      source: 'inferred',
    });
  }

  // Positive feedback → positive signal
  const positiveWords = ['很好', '完美', '不错', '厉害', '正是我想要的', 'perfect', 'great', 'exactly'];
  const isPositive = positiveWords.some(w => lower.includes(w));
  if (isPositive && userMsg.length < 100) {
    candidates.push({
      type: 'preference',
      data: { type: 'positive', category: 'communication', content: `用户确认有效: ${assistantMsg.substring(0, 100)}` },
      confidence: 0.5,
      source: 'inferred',
    });
  }

  return candidates;
}