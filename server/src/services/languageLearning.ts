// ================================================================
// Language Learning — Per-user language proficiency tracking
// ================================================================

import { prisma } from './db';

const LEVEL_RANKS: Record<string, number> = {
  unknown: 0, A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6,
  beginner: 1, elementary: 2, intermediate: 3, 'upper-intermediate': 4, advanced: 5,
};

const RANK_TO_LEVEL = ['unknown', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

export interface LanguageProfileResult {
  language: string;
  overallProficiency: string;
  confidence: number;
  freshness: number;
  readingLevel?: string;
  writingLevel?: string;
  technicalVocabLevel?: string;
  knownTerms: string[];
  preferences: { type: string; value: string }[];
}

export async function getLanguageProfile(userId: string, language: string): Promise<LanguageProfileResult | null> {
  try {
    const profile = await prisma.languageProfile.findUnique({
      where: { userId_language: { userId, language } },
      include: {
        skills: true,
        vocabularies: { where: { status: 'known' }, take: 50 },
        preferences: { where: { status: 'active' } },
      },
    });

    if (!profile) return null;

    const skillsMap: Record<string, string> = {};
    for (const s of profile.skills) {
      skillsMap[s.dimension] = s.level;
    }

    return {
      language: profile.language,
      overallProficiency: profile.overallProficiency,
      confidence: profile.confidence,
      freshness: profile.freshness,
      readingLevel: skillsMap['reading'],
      writingLevel: skillsMap['writing'],
      technicalVocabLevel: skillsMap['technical_vocabulary'],
      knownTerms: profile.vocabularies.map(v => v.term),
      preferences: profile.preferences.map(p => ({ type: p.type, value: p.value })),
    };
  } catch {
    return null;
  }
}

export async function getLanguageProfiles(userId: string): Promise<LanguageProfileResult[]> {
  try {
    const profiles = await prisma.languageProfile.findMany({
      where: { userId, status: 'active' },
      include: { skills: true, vocabularies: { where: { status: 'known' }, take: 30 } },
    });
    return profiles.map(p => ({
      language: p.language,
      overallProficiency: p.overallProficiency,
      confidence: p.confidence,
      freshness: p.freshness,
      readingLevel: p.skills.find(s => s.dimension === 'reading')?.level,
      writingLevel: p.skills.find(s => s.dimension === 'writing')?.level,
      technicalVocabLevel: p.skills.find(s => s.dimension === 'technical_vocabulary')?.level,
      knownTerms: p.vocabularies.map(v => v.term),
      preferences: [],
    }));
  } catch { return []; }
}

export function detectMessageLanguage(message: string, userDefault?: string): string {
  const latin = (message.match(/[a-zA-Z]/g) || []).length;
  const total = message.replace(/\s/g, '').length;
  if (total === 0) return userDefault?.startsWith('zh') ? 'zh' : 'en';
  const ratio = latin / total;
  if (ratio > 0.6) return 'en';
  if (ratio < 0.15) return 'zh';
  return userDefault?.startsWith('zh') ? 'zh' : 'en';
}

export async function updateLanguageFromMessage(
  userId: string,
  language: string,
  message: string,
): Promise<void> {
  try {
    if (language === 'zh') return; // Skip Chinese — native language assumed

    // Upsert profile
    const profile = await prisma.languageProfile.upsert({
      where: { userId_language: { userId, language } },
      create: {
        userId, language,
        overallProficiency: 'unknown',
        confidence: 0.2,
        evidenceCount: 1,
        freshness: 1.0,
        lastObservedAt: new Date(),
      },
      update: {},
    });

    // Basic skill assessment from message
    const wordCount = message.split(/\s+/).length;
    const avgWordLen = message.split(/\s+/).reduce((s, w) => s + w.length, 0) / Math.max(wordCount, 1);
    const hasComplexSentences = /[;:—]/.test(message) || message.split(/[.!?]/).length > 3;
    const hasErrors = detectGrammarIssues(message);

    let scoreDelta = 0;

    // Word count and complexity suggest level
    if (wordCount > 50 && avgWordLen > 5 && hasComplexSentences) scoreDelta += 0.03;
    if (wordCount > 100) scoreDelta += 0.02;
    if (avgWordLen > 6) scoreDelta += 0.02;
    if (hasErrors) scoreDelta -= 0.02;

    if (scoreDelta === 0) return;

    const oldRank = LEVEL_RANKS[profile.overallProficiency] ?? 0;
    const newRank = Math.max(0, Math.min(6, oldRank + scoreDelta));
    const newLevel = RANK_TO_LEVEL[Math.round(newRank)] || 'unknown';
    const newConfidence = Math.min(0.9, profile.confidence + 0.01);
    const newCount = profile.evidenceCount + 1;

    await prisma.languageProfile.update({
      where: { id: profile.id },
      data: {
        overallProficiency: newLevel,
        confidence: newConfidence,
        evidenceCount: newCount,
        freshness: 1.0,
        lastObservedAt: new Date(),
        lastAssessedAt: new Date(),
      },
    });

    // Update writing skill
    await prisma.languageSkill.upsert({
      where: { languageProfileId_dimension: { languageProfileId: profile.id, dimension: 'writing' } },
      create: { languageProfileId: profile.id, dimension: 'writing', level: newLevel, confidence: newConfidence, evidenceCount: 1, lastObservedAt: new Date() },
      update: { level: newLevel, confidence: newConfidence, evidenceCount: { increment: 1 }, lastObservedAt: new Date() },
    });

    // Extract and update vocabulary
    await updateVocabularyFromMessage(profile.id, message, language);

  } catch (err) {
    console.error('[LanguageLearning] updateLanguageFromMessage error:', err);
  }
}

async function updateVocabularyFromMessage(profileId: string, message: string, language: string): Promise<void> {
  const words = message.toLowerCase().split(/[\s,，。.!！?？;；:：""''（）()\n\t]+/)
    .filter(w => w.length >= 3);

  const unique = [...new Set(words)].slice(0, 20);

  for (const term of unique) {
    try {
      const existing = await prisma.languageVocabulary.findUnique({
        where: { languageProfileId_term: { languageProfileId: profileId, term } },
      });

      if (existing) {
        const newCount = existing.evidenceCount + 1;
        const newStatus = newCount >= 5 ? 'known' : existing.status;
        await prisma.languageVocabulary.update({
          where: { id: existing.id },
          data: { evidenceCount: newCount, status: newStatus, lastSeenAt: new Date() },
        });
      } else {
        await prisma.languageVocabulary.create({
          data: { languageProfileId: profileId, term, status: 'learning', evidenceCount: 1 },
        });
      }
    } catch {
      // Ignore duplicate errors
    }
  }
}

function detectGrammarIssues(text: string): boolean {
  // Simple heuristics for common English grammar issues
  const issues = [
    /\bi\b(?![''])/, // lowercase "i"
    /\b(is|are|was|were)\s+(is|are|was|were)\b/, // double verbs
    /\b(a)\s+([aeiou])/i, // "a" before vowel (should be "an")
    /\b(dont|doesnt|cant|wont|didnt|isnt|arent)\b/, // missing apostrophe
  ];
  return issues.some(p => p.test(text));
}

export async function getKnownTerms(userId: string, language: string): Promise<string[]> {
  try {
    const profile = await prisma.languageProfile.findUnique({
      where: { userId_language: { userId, language } },
    });
    if (!profile) return [];

    const terms = await prisma.languageVocabulary.findMany({
      where: { languageProfileId: profile.id, status: 'known' },
      select: { term: true },
      take: 100,
    });
    return terms.map(t => t.term);
  } catch { return []; }
}

// ==================== Language Mixing (code-mixing) ====================

export interface LanguageMix {
  primary: string;    // 主语言 zh/en/ja
  secondary: string;  // 混入语言
  mixRatio: number;   // 次要语言字符占比 0-1
  isMixed: boolean;
}

export function detectLanguageMix(message: string, userDefault?: string): LanguageMix {
  const cjk = (message.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (message.match(/[a-zA-Z]/g) || []).length;
  const kana = (message.match(/[\u3040-\u30ff]/g) || []).length;
  const total = cjk + latin + kana;
  if (total < 4) {
    const primary = userDefault?.startsWith('zh') ? 'zh' : 'en';
    return { primary, secondary: '', mixRatio: 0, isMixed: false };
  }
  const langs: [string, number][] = ([
    ['zh', cjk / total],
    ['en', latin / total],
    ['ja', kana / total],
  ] as [string, number][]).filter(([, r]) => r > 0);
  langs.sort((a, b) => b[1] - a[1]);
  const primary = langs[0][0];
  const secondary = langs[1]?.[0] ?? '';
  const mixRatio = Math.round((langs[1]?.[1] ?? 0) * 100) / 100;
  const isMixed = !!langs[1] && mixRatio >= 0.12 && mixRatio <= 0.85;
  return { primary, secondary, mixRatio, isMixed };
}

export async function recordLanguageMix(userId: string, mix: LanguageMix): Promise<void> {
  try {
    if (!mix.isMixed || !mix.secondary) return;
    const profile = await prisma.languageProfile.upsert({
      where: { userId_language: { userId, language: mix.primary } },
      create: { userId, language: mix.primary, overallProficiency: 'unknown', confidence: 0.2, evidenceCount: 1 },
      update: { evidenceCount: { increment: 1 } },
    });
    const value = `${mix.primary}|${mix.secondary} ratio=${mix.mixRatio.toFixed(2)}`;
    const existing = await prisma.languagePreference.findFirst({ where: { languageProfileId: profile.id, type: 'code_mixing' } });
    if (existing) {
      await prisma.languagePreference.update({ where: { id: existing.id }, data: { value, status: 'active' } });
    } else {
      await prisma.languagePreference.create({ data: { languageProfileId: profile.id, type: 'code_mixing', value, source: 'observed', status: 'active' } });
    }
  } catch (err) {
    console.error('[LanguageLearning] recordLanguageMix error:', err);
  }
}

// 读取该用户最近的 code-mixing 画像（供 prompt 注入）
export async function getCodeMixing(userId: string): Promise<{ primary: string; secondary: string; mixRatio: number } | null> {
  try {
    const prefs = await prisma.languagePreference.findMany({
      where: { type: 'code_mixing', status: 'active', languageProfile: { userId } },
      orderBy: { updatedAt: 'desc' },
      take: 1,
    });
    if (!prefs[0]) return null;
    const m = prefs[0].value.match(/([\w-]+)\|([\w-]+)\s+ratio=([0-9.]+)/);
    if (!m) return null;
    return { primary: m[1], secondary: m[2], mixRatio: parseFloat(m[3]) };
  } catch { return null; }
}