// ================================================================
// Domain Knowledge — Per-user domain/subdomain knowledge tracking
// ================================================================

import { prisma } from './db';

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  'AI': ['ai', '人工智能', 'machine learning', '机器学习', 'deep learning', '深度学习', 'neural', '神经网络', 'training', '训练', 'inference', '推理'],
  'AI/LLM': ['llm', '大模型', '大语言模型', 'gpt', 'claude', 'gemini', 'transformer', 'attention', 'tokenizer', 'embedding', 'prompt', 'fine-tune', '微调', 'rag', 'fine-tuning'],
  'AI/Agent': ['agent', '智能体', 'tool calling', 'function calling', 'planning', 'memory system', 'retrieval', 'chain-of-thought'],
  'Programming': ['code', '代码', 'programming', '编程', 'function', '函数', 'variable', '变量', 'algorithm', '算法', 'debug', '调试', 'compile', '编译'],
  'Programming/Python': ['python', 'pip', 'pandas', 'numpy', 'django', 'flask', 'fastapi', 'conda'],
  'Programming/JavaScript': ['javascript', 'js', 'typescript', 'ts', 'node', 'react', 'vue', 'angular', 'nextjs', 'npm'],
  'Programming/Database': ['database', '数据库', 'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'prisma', 'orm', 'migration'],
  'Programming/DevOps': ['docker', 'kubernetes', 'k8s', 'ci/cd', 'deploy', '部署', 'nginx', 'linux', 'server', 'aws', 'gcp'],
  'Photography': ['photography', '摄影', 'camera', '相机', 'lens', '镜头', 'aperture', '光圈', 'shutter', '快门', 'iso', 'exposure', '曝光', 'composition', '构图'],
  'Finance': ['finance', '金融', 'stock', '股票', 'investment', '投资', 'crypto', '加密', 'trading', '交易', 'market', '市场', 'fund', '基金', 'etf'],
  'Audio': ['audio', '音频', 'microphone', '麦克风', 'mixing', '混音', 'recording', '录音', 'synthesizer', '合成器', 'daw', 'equalizer'],
  'Science': ['science', '科学', 'physics', '物理', 'chemistry', '化学', 'biology', '生物', 'mathematics', '数学'],
  'Design': ['design', '设计', 'ui', 'ux', 'figma', 'photoshop', 'illustrator', 'typography', '字体', 'color theory'],
};

const LEVEL_TO_SCORE: Record<string, number> = {
  unknown: 0, beginner: 0.2, familiar: 0.4, intermediate: 0.6, advanced: 0.8, expert: 0.95,
};

const SCORE_TO_LEVEL = [
  { min: 0, level: 'unknown' },
  { min: 0.15, level: 'beginner' },
  { min: 0.35, level: 'familiar' },
  { min: 0.55, level: 'intermediate' },
  { min: 0.75, level: 'advanced' },
  { min: 0.9, level: 'expert' },
];

export function detectDomain(message: string): { domain: string | null; subdomain: string | null; confidence: number } {
  const lower = message.toLowerCase();
  const scores: { domain: string; score: number }[] = [];

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    let hits = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) hits++;
    }
    if (hits > 0) {
      scores.push({ domain, score: Math.min(1, hits * 0.3) });
    }
  }

  if (scores.length === 0) return { domain: null, subdomain: null, confidence: 0 };

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];

  // Split domain/subdomain
  const parts = best.domain.split('/');
  if (parts.length === 2) {
    return { domain: parts[0], subdomain: parts[1], confidence: best.score };
  }

  // Check if second best is a subdomain of first
  if (scores.length > 1) {
    const second = scores[1];
    if (second.domain.startsWith(best.domain + '/')) {
      return { domain: best.domain, subdomain: second.domain.split('/')[1], confidence: best.score };
    }
  }

  return { domain: best.domain, subdomain: null, confidence: best.score };
}

export interface DomainAssessment {
  domain: string;
  level: string;
  confidence: number;
  freshness: number;
  evidenceCount: number;
  subdomains: { subdomain: string; level: string; confidence: number }[];
  knownTerms: string[];
}

export async function getDomainProfile(userId: string, domain: string): Promise<DomainAssessment | null> {
  try {
    const profile = await prisma.domainProfile.findUnique({
      where: { userId_domain: { userId, domain } },
      include: { subdomains: true, evidences: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });

    if (!profile) return null;

    // Extract known terms from evidence（content 存“词1, 词2”，拆开成词表）
    const knownTerms = Array.from(new Set(
      profile.evidences
        .filter(e => e.evidenceType === 'terminology')
        .flatMap(e => e.content.split(/[,，;；\s]+/))
        .map(t => t.trim())
        .filter(t => t.length >= 2 && !/^(Used|domain|terms)$/i.test(t))
    )).slice(0, 30);

    return {
      domain: profile.domain,
      level: profile.level,
      confidence: profile.confidence,
      freshness: profile.freshness,
      evidenceCount: profile.evidenceCount,
      subdomains: profile.subdomains.map(s => ({
        subdomain: s.subdomain,
        level: s.level,
        confidence: s.confidence,
      })),
      knownTerms,
    };
  } catch {
    return null;
  }
}

export async function getEffectiveLevel(
  userId: string,
  domain: string,
  subdomain?: string,
): Promise<{ level: string; confidence: number; freshness: number; knownTerms: string[] }> {
  const profile = await getDomainProfile(userId, domain);

  if (!profile) {
    return { level: 'unknown', confidence: 0, freshness: 1.0, knownTerms: [] };
  }

  // Check subdomain override
  if (subdomain) {
    const sub = profile.subdomains.find(s => s.subdomain === subdomain);
    if (sub && sub.confidence > profile.confidence * 0.8) {
      return {
        level: sub.level,
        confidence: sub.confidence,
        freshness: profile.freshness,
        knownTerms: profile.knownTerms,
      };
    }
  }

  return {
    level: profile.level,
    confidence: profile.confidence,
    freshness: profile.freshness,
    knownTerms: profile.knownTerms,
  };
}

export async function assessFromMessage(
  userId: string,
  domain: string,
  subdomain: string | null,
  message: string,
  conversationId?: string,
): Promise<void> {
  try {
    const lower = message.toLowerCase();
    let scoreDelta = 0;
    let evidenceType = 'question_complexity';
    const evidenceDetails: string[] = [];

    // Advanced terminology usage — 记录具体命中的术语词（供 knownTerms 使用）
    const domainKeywords = DOMAIN_KEYWORDS[domain] || DOMAIN_KEYWORDS[`${domain}/${subdomain}`] || [];
    let termHits = 0;
    const hitTerms: string[] = [];
    for (const kw of domainKeywords) {
      if (lower.includes(kw)) { termHits++; hitTerms.push(kw); }
    }
    if (termHits >= 2) {
      scoreDelta += 0.05;
      evidenceType = 'terminology';
      evidenceDetails.push(hitTerms.slice(0, 10).join(', '));
    }

    // Correction signal — user corrects the assistant
    const correctionWords = ['不对', '错了', '不是这样', '应该是', 'actually', 'it should be', 'correction'];
    const isCorrection = correctionWords.some(w => lower.includes(w));
    if (isCorrection) {
      scoreDelta += 0.15;
      evidenceType = 'correction';
      evidenceDetails.push('Corrected assistant');
    }

    // Advanced question patterns
    const advancedPatterns = [/为什么.*(?:不|没有|失败)/, /如何优化/, /原理/, /底层/, /实现机制/, /architecture/, /optimization/, /trade-?off/];
    const isAdvanced = advancedPatterns.some(p => p.test(message));
    if (isAdvanced) {
      scoreDelta += 0.08;
      evidenceType = 'conceptual';
      evidenceDetails.push('Asked advanced question');
    }

    // Basic question patterns
    const basicPatterns = [/什么是/, /怎么用/, /是什么/, /入门/, /初学/, /what is/, /how to use/, /basics/];
    const isBasic = basicPatterns.some(p => p.test(message));
    if (isBasic) {
      scoreDelta -= 0.05;
      evidenceType = 'basic_question';
      evidenceDetails.push('Asked basic question');
    }

    if (scoreDelta === 0) return; // No signal

    // Upsert domain profile
    const profile = await prisma.domainProfile.upsert({
      where: { userId_domain: { userId, domain } },
      create: {
        userId, domain,
        level: scoreDelta > 0 ? 'beginner' : 'unknown',
        confidence: 0.2,
        evidenceCount: 1,
        freshness: 1.0,
        lastObservedAt: new Date(),
        lastAssessedAt: new Date(),
      },
      update: {},
    });

    // Calculate new level
    const oldScore = LEVEL_TO_SCORE[profile.level] ?? 0;
    const learningRate = Math.max(0.05, 0.3 / Math.sqrt(profile.evidenceCount + 1));
    const newScore = Math.max(0, Math.min(1, oldScore + scoreDelta * learningRate));
    const newLevel = [...SCORE_TO_LEVEL].reverse().find(l => newScore >= l.min)?.level || 'unknown';
    const newConfidence = Math.min(0.95, profile.confidence + 0.02);
    const newCount = profile.evidenceCount + 1;

    await prisma.domainProfile.update({
      where: { id: profile.id },
      data: {
        level: newLevel,
        confidence: newConfidence,
        evidenceCount: newCount,
        freshness: 1.0,
        lastObservedAt: new Date(),
        lastAssessedAt: new Date(),
      },
    });

    // Update subdomain if applicable
    if (subdomain) {
      const existing = await prisma.domainSubdomain.findUnique({
        where: { domainProfileId_subdomain: { domainProfileId: profile.id, subdomain } },
      });

      if (existing) {
        const subOldScore = LEVEL_TO_SCORE[existing.level] ?? 0;
        const subNewScore = Math.max(0, Math.min(1, subOldScore + scoreDelta * learningRate));
        const subNewLevel = [...SCORE_TO_LEVEL].reverse().find(l => subNewScore >= l.min)?.level || 'unknown';
        await prisma.domainSubdomain.update({
          where: { id: existing.id },
          data: {
            level: subNewLevel,
            confidence: Math.min(0.95, existing.confidence + 0.02),
            evidenceCount: existing.evidenceCount + 1,
            freshness: 1.0,
            lastObservedAt: new Date(),
          },
        });
      } else {
        await prisma.domainSubdomain.create({
          data: {
            domainProfileId: profile.id,
            subdomain,
            level: scoreDelta > 0 ? 'beginner' : 'unknown',
            confidence: 0.2,
            evidenceCount: 1,
            lastObservedAt: new Date(),
          },
        });
      }
    }

    // Log evidence
    await prisma.domainEvidence.create({
      data: {
        domainProfileId: profile.id,
        subdomain,
        evidenceType,
        content: evidenceDetails.join('; '),
        impact: scoreDelta,
        conversationId,
      },
    }).catch(() => {});

  } catch (err) {
    console.error('[DomainKnowledge] assessFromMessage error:', err);
  }
}

export async function getDomainProfiles(userId: string): Promise<DomainAssessment[]> {
  try {
    const profiles = await prisma.domainProfile.findMany({
      where: { userId },
      include: { subdomains: true },
      orderBy: { confidence: 'desc' },
    });
    return profiles.map(p => ({
      domain: p.domain,
      level: p.level,
      confidence: p.confidence,
      freshness: p.freshness,
      evidenceCount: p.evidenceCount,
      subdomains: p.subdomains.map(s => ({ subdomain: s.subdomain, level: s.level, confidence: s.confidence })),
      knownTerms: [],
    }));
  } catch { return []; }
}