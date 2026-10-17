// ================================================================
// Memory Evolution — User-level adaptive profile evolution
// ================================================================
//
// DIFFERENT from evolution.ts (system-level).
// This module adapts the USER'S profile based on interaction evidence.
// It NEVER modifies core prompts, kernels, or system behavior.

import { prisma } from './db';
import { getAdaptiveProfile, updateAdaptiveProfile, addPreference } from './userMemory';
import { detectDomain, assessFromMessage } from './domainKnowledge';
import { updateLanguageFromMessage, detectMessageLanguage, detectLanguageMix, recordLanguageMix } from './languageLearning';
import type { AdaptiveProfileData } from './responseCalibration';

const LEARNING_RATE = 0.05;

export async function extractAndEvolve(
  userId: string,
  userMessage: string,
  assistantResponse: string,
  conversationId?: string,
  language?: string,
): Promise<void> {
  try {
    // 1. Domain knowledge assessment
    const domainInfo = detectDomain(userMessage);
    if (domainInfo.domain && domainInfo.confidence > 0.3) {
      await assessFromMessage(userId, domainInfo.domain, domainInfo.subdomain, userMessage, conversationId);
    }

    // 2. Language assessment
    const msgLang = detectMessageLanguage(userMessage, language);
    if (msgLang && msgLang !== 'zh') {
      await updateLanguageFromMessage(userId, msgLang, userMessage);
    }

    // 2b. Language mixing (code-mixing) — 无条件检测/记录（中英混时主语言可能判 zh）
    const mix = detectLanguageMix(userMessage, language);
    if (mix.isMixed) {
      await recordLanguageMix(userId, mix);
    }

    // 3. Adaptive profile signals
    const signals = detectBehaviorSignals(userMessage, assistantResponse);
    if (signals.length > 0) {
      const profile = await getAdaptiveProfile(userId);
      const updated = applySignals(profile, signals);
      if (updated) {
        await updateAdaptiveProfile(userId, updated);
      }
    }

    // 4. Interest tracking
    if (domainInfo.domain && domainInfo.confidence > 0.3) {
      const { observeInterest } = await import('./userMemory');
      await observeInterest(userId, domainInfo.domain, domainInfo.subdomain || '*');
    }

    // 5. Preference extraction from explicit statements
    const candidates = extractExplicitPreferences(userMessage);
    for (const c of candidates) {
      await addPreference(userId, c);
    }

    // 6. 地区共享习惯聚合（极低频 fire-and-forget；主靠 cron/admin，此处作补充）
    if (Math.random() < 0.02) {
      const { aggregateAllRegions } = await import('./regionExpression');
      void aggregateAllRegions().catch(() => {});
    }

  } catch (err) {
    console.error('[MemoryEvolution] extractAndEvolve error:', err);
  }
}

interface BehaviorSignal {
  dimension: 'detailLevel' | 'directness' | 'technicalDepth' | 'formality' | 'structuredAnswer' | 'compareBeforeDecide';
  delta: number; // positive or negative
  reason: string;
}

function detectBehaviorSignals(userMsg: string, assistantResp: string): BehaviorSignal[] {
  const signals: BehaviorSignal[] = [];
  const lower = userMsg.toLowerCase();

  // Too detailed → reduce detail
  if (/太长|太详细|太啰|简洁一点|简短|too long|too detailed|be concise|brief/.test(lower)) {
    signals.push({ dimension: 'detailLevel', delta: -0.1, reason: 'User wants less detail' });
  }
  // Too short → increase detail
  if (/太短|不够详细|详细一点|更多细节|more detail|explain more|elaborate/.test(lower)) {
    signals.push({ dimension: 'detailLevel', delta: 0.1, reason: 'User wants more detail' });
  }
  // Wants direct answers
  if (/直接说|直接一点|不要绕|just tell me|straight answer|direct/.test(lower)) {
    signals.push({ dimension: 'directness', delta: 0.1, reason: 'User prefers direct answers' });
  }
  // Wants technical depth
  if (/更技术|更深入|底层原理|technical|deep dive|in-depth/.test(lower)) {
    signals.push({ dimension: 'technicalDepth', delta: 0.1, reason: 'User wants more technical depth' });
  }
  // Wants less technical
  if (/太技术|听不懂|简单一点|通俗|simpler|less technical|eli5/.test(lower)) {
    signals.push({ dimension: 'technicalDepth', delta: -0.1, reason: 'User wants less technical' });
  }
  // Wants comparison
  if (/对比|比较|优缺点|各有什么|pros and cons|compare/.test(lower)) {
    signals.push({ dimension: 'compareBeforeDecide', delta: 0.05, reason: 'User values comparison' });
  }
  // Wants structured output
  if (/表格|列表|list|table|structured|bullet/.test(lower)) {
    signals.push({ dimension: 'structuredAnswer', delta: 0.05, reason: 'User likes structured format' });
  }

  return signals;
}

function applySignals(profile: AdaptiveProfileData, signals: BehaviorSignal[]): Partial<AdaptiveProfileData> | null {
  let changed = false;
  const result: any = {
    communication: { ...profile.communication },
    format: { ...profile.format },
    workflow: { ...profile.workflow },
  };

  for (const s of signals) {
    if (['detailLevel', 'directness', 'technicalDepth', 'formality'].includes(s.dimension)) {
      const key = s.dimension as keyof typeof result.communication;
      const old = result.communication[key];
      result.communication[key] = Math.max(0, Math.min(1, old + s.delta));
      if (result.communication[key] !== old) changed = true;
    }
    if (['structuredAnswer'].includes(s.dimension)) {
      const key = s.dimension as keyof typeof result.format;
      const old = result.format[key];
      result.format[key] = Math.max(0, Math.min(1, old + s.delta));
      if (result.format[key] !== old) changed = true;
    }
    if (['compareBeforeDecide'].includes(s.dimension)) {
      const key = s.dimension as keyof typeof result.workflow;
      const old = result.workflow[key];
      result.workflow[key] = Math.max(0, Math.min(1, old + s.delta));
      if (result.workflow[key] !== old) changed = true;
    }
  }

  return changed ? result : null;
}

function extractExplicitPreferences(message: string): { type: 'positive' | 'negative'; category: string; content: string; source: 'explicit'; strength: number }[] {
  const results: any[] = [];
  const lower = message;

  // "以后..." patterns
  const futurePref = lower.match(/(?:以后|从现在开始|往后|今后)(.{5,60})(?:回答|回复|输出|这样说|这样写)/);
  if (futurePref) {
    results.push({ type: 'positive', category: 'communication', content: futurePref[0], source: 'explicit', strength: 0.9 });
  }

  // "不要..." patterns
  const negativePref = lower.match(/(?:不要|别|不需要|禁止)(.{3,50})/);
  if (negativePref) {
    results.push({ type: 'negative', category: 'communication', content: negativePref[0], source: 'explicit', strength: 0.85 });
  }

  // "记住..." patterns
  const remember = lower.match(/(?:请记住|记住|不要忘|一直这样|always remember)(.{5,80})/);
  if (remember) {
    results.push({ type: 'positive', category: 'interaction', content: remember[0], source: 'explicit', strength: 0.95 });
  }

  return results;
}