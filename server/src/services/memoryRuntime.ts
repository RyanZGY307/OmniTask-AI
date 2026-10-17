// ================================================================
// Memory Runtime — Orchestrator
// ================================================================
//
// beforeResponse(): loads all relevant memory, returns calibration context
// afterResponse(): extracts candidates, validates, persists, evolves
//
// MEMORY NEVER BLOCKS OR CRASHES THE MAIN CHAT FLOW.

import { prisma } from './db';
import {
  getAdaptiveProfile,
  getPreferences,
  getRequirements,
  getActiveHabits,
  getInterests,
  extractMemoryCandidates,
} from './userMemory';
import {
  detectDomain,
  getEffectiveLevel,
  getDomainProfile,
  type DomainAssessment,
} from './domainKnowledge';
import {
  getLanguageProfile,
  detectMessageLanguage,
  getCodeMixing,
  type LanguageProfileResult,
} from './languageLearning';
import {
  getExpressionContext,
  buildExpressionSection,
  buildRegionSection,
  learnFromUserMessage,
} from './expressionLearning';
import { getRegionHabitsForUser } from './regionExpression';
import {
  getRelevantLongTermMemories,
  createLongTermMemory,
  reinforceMemory,
} from './longTermMemory';
import {
  checkConflicts,
  resolveConflict,
  validateMemory,
} from './memoryConsistency';
import { extractAndEvolve } from './memoryEvolution';
import { getRelevantFiles } from './fileMemory';
import {
  calibrate,
  DEFAULT_CALIBRATION,
  type CalibrationContext,
  type AdaptiveProfileData,
} from './responseCalibration';

// ==================== Types ====================

export interface BeforeContext {
  calibration: CalibrationContext;
  relevantMemories: { category: string; content: string }[];
  domainProfile: DomainAssessment | null;
  languageProfile: LanguageProfileResult | null;
  preferences: any[];
  requirements: any[];
  adaptiveProfile: AdaptiveProfileData;
  domainInfo: { domain: string | null; subdomain: string | null; confidence: number };
  expressionSection: string;
}

// ==================== Before Response ====================

export async function beforeResponse(
  userId: string,
  message: string,
  conversationId: string,
  userLanguage?: string,
): Promise<BeforeContext> {
  try {
    // Parallel queries
    const [adaptiveProfile, preferences, requirements, interests, longTermMems] = await Promise.all([
      getAdaptiveProfile(userId).catch(() => null),
      getPreferences(userId).catch(() => []),
      getRequirements(userId).catch(() => []),
      getInterests(userId).catch(() => []),
      getRelevantLongTermMemories(userId, message, conversationId, 8).catch(() => []),
    ]);

    const profile = adaptiveProfile || getDefaultProfile();

    // Detect domain
    const domainInfo = detectDomain(message);

    // Load domain profile
    let domainProfile: DomainAssessment | null = null;
    if (domainInfo.domain) {
      domainProfile = await getDomainProfile(userId, domainInfo.domain).catch(() => null);
    }

    // Load language profile
    const detectedLang = detectMessageLanguage(message, userLanguage);
    let languageProfile: LanguageProfileResult | null = null;
    if (detectedLang && detectedLang !== 'zh') {
      languageProfile = await getLanguageProfile(userId, detectedLang).catch(() => null);
    }

    // Load expression style profile
    const expressionCtx = await getExpressionContext(userId).catch(() => null);
    let expressionSection = expressionCtx ? buildExpressionSection(expressionCtx) : '';

    // Region shared habits（地区共享，个人优先）
    const regionHabits = await getRegionHabitsForUser(userId).catch(() => []);
    if (regionHabits.length) {
      expressionSection += (expressionSection ? '\n' : '') + buildRegionSection(regionHabits);
    }

    // Detect task type
    const taskType = detectTaskType(message);

    // Build domain calibration input
    const domainCalibrationInput = domainProfile ? {
      level: domainProfile.level,
      confidence: domainProfile.confidence,
      freshness: domainProfile.freshness,
      knownTerms: domainProfile.knownTerms,
    } : null;

    // Code-mixing（语言混合）画像 — 供 calibrate 注入
    const codeMixing = await getCodeMixing(userId).catch(() => null);

    // Calibrate
    const calibration = calibrate({
      domainProfile: domainCalibrationInput,
      languageProfile: languageProfile || undefined,
      preferences,
      requirements,
      adaptiveProfile: profile,
      taskType,
      domainInfo,
      userLanguage,
      codeMixing,
    });

    // Merge all relevant memories into prompt-ready format
    const relevantMemories: { category: string; content: string }[] = [];

    // User preferences
    for (const p of preferences.slice(0, 5)) {
      relevantMemories.push({ category: `preference_${p.category}`, content: `[${p.type}] ${p.content}` });
    }

    // User requirements
    for (const r of requirements.slice(0, 5)) {
      relevantMemories.push({ category: `requirement_${r.category}`, content: `[${r.priority}] ${r.content}` });
    }

    // Long-term memories
    for (const m of longTermMems.slice(0, 5)) {
      relevantMemories.push({ category: `memory_${m.type}`, content: m.content });
    }

    // Active habits
    const habits = await getActiveHabits(userId).catch(() => []);
    for (const h of habits.slice(0, 3)) {
      relevantMemories.push({ category: 'habit', content: `[${h.type}] ${h.description}` });
    }

    return {
      calibration,
      relevantMemories,
      domainProfile,
      languageProfile,
      preferences,
      requirements,
      adaptiveProfile: profile,
      domainInfo,
      expressionSection,
    };
  } catch (err) {
    console.error('[Memory] beforeResponse error:', err);
    return {
      calibration: DEFAULT_CALIBRATION,
      relevantMemories: [],
      domainProfile: null,
      languageProfile: null,
      preferences: [],
      requirements: [],
      adaptiveProfile: getDefaultProfile(),
      domainInfo: { domain: null, subdomain: null, confidence: 0 },
      expressionSection: '',
    };
  }
}

// ==================== After Response ====================

export async function afterResponse(
  userId: string,
  conversationId: string,
  userMessage: string,
  assistantResponse: string,
  language?: string,
): Promise<void> {
  try {
    // 1. Extract memory candidates from the exchange
    const candidates = extractMemoryCandidates(userMessage, assistantResponse);

    // Process preference candidates
    for (const c of candidates) {
      if (c.type === 'preference') {
        const { addPreference } = await import('./userMemory');
        await addPreference(userId, { ...c.data, source: c.source, strength: c.confidence });
      }
      if (c.type === 'requirement') {
        const { addRequirement } = await import('./userMemory');
        await addRequirement(userId, { ...c.data, source: c.source });
      }
    }

    // 2. Extract conversation facts (important statements from assistant)
    await extractConversationFacts(userId, conversationId, userMessage, assistantResponse);

    // 3. Detect and record decisions
    await detectDecisions(userId, conversationId, userMessage, assistantResponse);

    // 4. Run user-level evolution (domain + language + adaptive profile)
    await extractAndEvolve(userId, userMessage, assistantResponse, conversationId, language);

    // 4b. Learn the user's expression style (fire-and-forget, isolated)
    await learnFromUserMessage(userId, userMessage, { language }).catch(() => {});

    // 4c. Enqueue system-level Evolution Pipeline job (background, non-blocking).
    // This is a SEPARATE runtime chain from the user-level extractAndEvolve
    // above: it only enqueues a job row; the actual runEvolutionPipeline
    // executes later in the Worker Pool. Enqueue failure never affects the
    // response already delivered.
    try {
      const { enqueueEvolutionPipelineJob } = await import('./evolutionManager');
      await enqueueEvolutionPipelineJob(userId, conversationId, undefined).catch(() => undefined);
    } catch { /* enqueue is best-effort; never block or crash the chat flow */ }

    // 5. Run stale detection (lightweight, every 20th call approximately)
    if (Math.random() < 0.05) {
      const { runStaleDetection } = await import('./memoryLifecycle');
      await runStaleDetection(userId).catch(() => {});
      const { applyExpressionDecay } = await import('./expressionLearning');
      await applyExpressionDecay(userId).catch(() => {});
    }

  } catch (err) {
    console.error('[Memory] afterResponse error:', err);
  }
}

// ==================== Private Helpers ====================

async function extractConversationFacts(
  userId: string,
  conversationId: string,
  userMsg: string,
  assistantResp: string,
): Promise<void> {
  // Only extract facts from longer, substantive responses
  if (assistantResp.length < 100) return;

  // Check for data-rich content (numbers, dates, names)
  const hasData = /\d{4}[-/]\d{2}|\d+(\.\d+)?[%元美元¥€£]|[A-Z][a-z]+\s[A-Z][a-z]+/.test(assistantResp);

  if (hasData) {
    // Extract the most informative snippet
    const sentences = assistantResp.split(/[。.!！\n]/).filter(s => s.trim().length > 20);
    const dataSentences = sentences.filter(s => /\d/.test(s));

    if (dataSentences.length > 0) {
      const content = dataSentences.slice(0, 3).join('。').substring(0, 300);

      // Validate
      const validation = validateMemory({ content, type: 'conversation_fact', userId });
      if (!validation.valid) return;

      // Check conflicts
      const conflicts = await checkConflicts(userId, 'conversation_fact', content, 'conversation');

      if (conflicts.length > 0 && conflicts[0].resolution === 'duplicate') {
        await reinforceMemory(conflicts[0].existingMemoryId);
      } else if (conflicts.length > 0 && conflicts[0].resolution === 'replace') {
        await resolveConflict(conflicts[0], userId, async () => {
          const mem = await createLongTermMemory({
            userId, type: 'conversation_fact', content, conversationId,
            sourceType: 'conversation', confidence: 0.6, importance: 0.4,
          });
          return mem.id;
        });
      } else {
        await createLongTermMemory({
          userId, type: 'conversation_fact', content, conversationId,
          sourceType: 'conversation', confidence: 0.5, importance: 0.3,
        });
      }
    }
  }
}

async function detectDecisions(
  userId: string,
  conversationId: string,
  userMsg: string,
  assistantResp: string,
): Promise<void> {
  // Decision patterns
  const decisionPatterns = [
    /(?:我们)?(?:决定|确认|选择|确定)(.{10,100})/,
    /(?:就这样|就按这个|就这么办)(.{5,80})/,
    /(?:let's|we'll|decided to|going with)\s+(.{10,100})/i,
    /(?:use|采用|使用)\s*(.{5,60})(?:方案|方案|approach|solution)/i,
  ];

  for (const pattern of decisionPatterns) {
    const match = userMsg.match(pattern) || assistantResp.match(pattern);
    if (match) {
      await createLongTermMemory({
        userId,
        type: 'conversation_decision',
        content: match[0].substring(0, 300),
        conversationId,
        sourceType: 'conversation',
        confidence: 0.7,
        importance: 0.6,
      }).catch(() => {});
      break; // One decision per exchange
    }
  }
}

function detectTaskType(message: string): string {
  const lower = message.toLowerCase();
  if (/写代码|code|编程|implement|实现|debug|调试|fix|修复|函数|function|api/.test(lower)) return 'coding';
  if (/研究|research|分析|analyze|调查|对比|比较|compare/.test(lower)) return 'research';
  if (/翻译|translate|改写|rewrite/.test(lower)) return 'translation';
  if (/写|write|文章|essay|报告|report|文案|copy/.test(lower)) return 'writing';
  if (/计算|calculate|算|math|数学|公式/.test(lower)) return 'math';
  if (/设计|design|ui|ux|界面/.test(lower)) return 'design';
  return 'general';
}

function getDefaultProfile(): AdaptiveProfileData {
  return {
    communication: { detailLevel: 0.5, directness: 0.5, technicalDepth: 0.5, formality: 0.5 },
    format: { structuredAnswer: 0.5, useTables: 0.3, useMarkdown: 0.5, useBulletPoints: 0.4 },
    workflow: { compareBeforeDecide: 0.3, iterativeRefinement: 0.3, analysisFirst: 0.3 },
  };
}