// ================================================================
// Response Calibration Engine
// ================================================================
// Pure computation — no DB calls. Takes context, returns calibration.

export interface CalibrationContext {
  contentDepth: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  vocabularyDensity: number;       // 0–1
  explanationDepth: 'minimal' | 'moderate' | 'detailed';
  sentenceComplexity: 'simple' | 'moderate' | 'complex';
  terminologyPolicy: {
    knownTerms: string[];
    explainNewTerms: boolean;
    maxNewTermsPerResponse: number;
  };
  translationPolicy: {
    bilingual: boolean;
    explainInLanguage: string | null;
  };
  languageSelection: string;
  formattingStrategy: 'structured' | 'narrative' | 'mixed';
  domainLevel: string;
  languageLevel: string;
  domainFreshness: number;
  adaptiveSignals: {
    detailPreference: number;
    directness: number;
    technicalDepth: number;
  };
  codeMixing?: { primary: string; secondary: string; mixRatio: number } | null;
}

export interface CalibrateInput {
  domainProfile?: {
    level: string;
    confidence: number;
    freshness: number;
    knownTerms: string[];
  } | null;
  languageProfile?: {
    overallProficiency: string;
    confidence: number;
    readingLevel?: string;
    writingLevel?: string;
    technicalVocabLevel?: string;
  } | null;
  preferences: { category: string; type: string; content: string; strength: number; source: string }[];
  requirements: { category: string; content: string; priority: string }[];
  adaptiveProfile: AdaptiveProfileData;
  taskType: string;
  domainInfo: { domain: string | null; confidence: number };
  userLanguage?: string;
  codeMixing?: { primary: string; secondary: string; mixRatio: number } | null;
}

export interface AdaptiveProfileData {
  communication: {
    detailLevel: number;
    directness: number;
    technicalDepth: number;
    formality: number;
  };
  format: {
    structuredAnswer: number;
    useTables: number;
    useMarkdown: number;
    useBulletPoints: number;
  };
  workflow: {
    compareBeforeDecide: number;
    iterativeRefinement: number;
    analysisFirst: number;
  };
}

const LEVEL_RANKS: Record<string, number> = {
  unknown: 0, beginner: 1, familiar: 2, intermediate: 3, advanced: 4, expert: 5,
  A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6,
};

function levelToDepth(level: string, confidence: number): CalibrationContext['contentDepth'] {
  const rank = LEVEL_RANKS[level] ?? 0;
  const effective = rank * Math.max(confidence, 0.3);
  if (effective >= 4) return 'expert';
  if (effective >= 3) return 'advanced';
  if (effective >= 1.5) return 'intermediate';
  return 'beginner';
}

export function calibrate(input: CalibrateInput): CalibrationContext {
  const {
    domainProfile, languageProfile, preferences, requirements,
    adaptiveProfile, taskType, domainInfo, userLanguage, codeMixing,
  } = input;

  // 1. Content Depth = f(domainLevel, technicalDepth preference)
  const domainLevel = domainProfile?.level || 'unknown';
  const domainConfidence = domainProfile?.confidence || 0;
  const domainFreshness = domainProfile?.freshness ?? 1.0;

  let contentDepth = levelToDepth(domainLevel, domainConfidence);
  // Adaptive boost: if user prefers high technical depth, bump up
  if (adaptiveProfile.communication.technicalDepth > 0.7 && contentDepth === 'intermediate') {
    contentDepth = 'advanced';
  }

  // 2. Vocabulary Density = f(domain, language, terminology)
  let vocabDensity = 0.3;
  if (domainConfidence > 0.5) {
    vocabDensity = Math.min(0.9, domainConfidence * 0.8 + adaptiveProfile.communication.technicalDepth * 0.2);
  }
  if (languageProfile && (LEVEL_RANKS[languageProfile.overallProficiency] ?? 0) < 3) {
    vocabDensity = Math.min(vocabDensity, 0.4);
  }

  // 3. Explanation Depth = f(detail preference, task type)
  let explanationDepth: CalibrationContext['explanationDepth'] = 'moderate';
  const detailPref = adaptiveProfile.communication.detailLevel;
  if (detailPref > 0.7 || taskType === 'research') explanationDepth = 'detailed';
  if (detailPref < 0.3 || taskType === 'simple_chat') explanationDepth = 'minimal';

  // Check explicit requirements
  for (const req of requirements) {
    if (req.category === 'answer' && req.content.includes('详细')) explanationDepth = 'detailed';
    if (req.category === 'answer' && req.content.includes('简洁')) explanationDepth = 'minimal';
  }

  // 4. Sentence Complexity = f(language level, directness)
  const langLevel = languageProfile?.overallProficiency || 'unknown';
  let sentenceComplexity: CalibrationContext['sentenceComplexity'] = 'moderate';
  if ((LEVEL_RANKS[langLevel] ?? 0) >= 4) sentenceComplexity = 'complex';
  if ((LEVEL_RANKS[langLevel] ?? 0) <= 2 || adaptiveProfile.communication.directness > 0.8) {
    sentenceComplexity = 'simple';
  }

  // 5. Terminology Policy
  const knownTerms = domainProfile?.knownTerms || [];
  const explainNew = (LEVEL_RANKS[domainLevel] ?? 0) < 3;
  const maxNewTerms = contentDepth === 'beginner' ? 2 : contentDepth === 'intermediate' ? 4 : 6;

  // 6. Translation Policy
  let bilingual = false;
  let explainInLanguage: string | null = null;
  if (languageProfile && (LEVEL_RANKS[langLevel] ?? 0) <= 2) {
    bilingual = true;
    explainInLanguage = userLanguage || 'zh-CN';
  }
  // Check explicit language preferences
  for (const pref of preferences) {
    if (pref.category === 'communication' && pref.content.includes('双语')) bilingual = true;
    if (pref.category === 'communication' && pref.content.includes('不要翻译')) bilingual = false;
  }

  // 7. Language Selection
  const languageSelection = userLanguage || 'zh-CN';

  // 8. Formatting Strategy
  let formattingStrategy: CalibrationContext['formattingStrategy'] = 'mixed';
  if (adaptiveProfile.format.structuredAnswer > 0.7) formattingStrategy = 'structured';
  if (adaptiveProfile.format.structuredAnswer < 0.3) formattingStrategy = 'narrative';
  if (taskType === 'writing' || taskType === 'creative') formattingStrategy = 'narrative';

  return {
    contentDepth,
    vocabularyDensity: Math.round(vocabDensity * 100) / 100,
    explanationDepth,
    sentenceComplexity,
    terminologyPolicy: { knownTerms, explainNewTerms: explainNew, maxNewTermsPerResponse: maxNewTerms },
    translationPolicy: { bilingual, explainInLanguage },
    languageSelection,
    formattingStrategy,
    domainLevel,
    languageLevel: langLevel,
    domainFreshness,
    codeMixing,
    adaptiveSignals: {
      detailPreference: adaptiveProfile.communication.detailLevel,
      directness: adaptiveProfile.communication.directness,
      technicalDepth: adaptiveProfile.communication.technicalDepth,
    },
  };
}

export function buildCalibrationSection(cal: CalibrationContext): string {
  const lines = ['[Response Calibration — adapt to this user]'];

  lines.push(`Content depth: ${cal.contentDepth}`);
  lines.push(`Explanation: ${cal.explanationDepth}`);
  lines.push(`Sentence complexity: ${cal.sentenceComplexity}`);
  lines.push(`Vocabulary density: ${cal.vocabularyDensity}`);

  if (cal.terminologyPolicy.explainNewTerms) {
    lines.push(`New terms: explain on first use (max ${cal.terminologyPolicy.maxNewTermsPerResponse} per response)`);
  } else {
    lines.push('New terms: use freely, user is familiar with domain terminology');
  }

  if (cal.terminologyPolicy.knownTerms.length > 0) {
    lines.push(`Known terms (no explanation needed): ${cal.terminologyPolicy.knownTerms.slice(0, 15).join(', ')}`);
  }

  if (cal.translationPolicy.bilingual) {
    lines.push(`Translation: provide key term translations in ${cal.translationPolicy.explainInLanguage}`);
  }

  lines.push(`Formatting: ${cal.formattingStrategy}`);
  lines.push(`Domain: ${cal.domainLevel} (confidence based)`);
  if (cal.domainLevel === 'unknown' || cal.domainLevel === 'beginner' || cal.contentDepth === 'beginner') {
    lines.push('Beginner domain: treat the user as new to this topic — avoid jargon they have not shown they know, and explain any new term on first use (do not assume familiarity).');
  }
  lines.push(`Language proficiency: ${cal.languageLevel}`);
  lines.push(`Response language: ${cal.languageSelection}`);
  if (cal.codeMixing && cal.codeMixing.secondary) {
    lines.push(`Code-mixing: user mixes ${cal.codeMixing.primary} + ${cal.codeMixing.secondary} (~${Math.round(cal.codeMixing.mixRatio * 100)}% ${cal.codeMixing.secondary}); keep occasional ${cal.codeMixing.secondary} terms to match, don't force pure-${cal.codeMixing.primary}.`);
  }

  return lines.join('\n');
}

export const DEFAULT_CALIBRATION: CalibrationContext = {
  contentDepth: 'intermediate',
  vocabularyDensity: 0.4,
  explanationDepth: 'moderate',
  sentenceComplexity: 'moderate',
  terminologyPolicy: { knownTerms: [], explainNewTerms: true, maxNewTermsPerResponse: 4 },
  translationPolicy: { bilingual: false, explainInLanguage: null },
  languageSelection: 'zh-CN',
  formattingStrategy: 'mixed',
  domainLevel: 'unknown',
  languageLevel: 'unknown',
  domainFreshness: 1.0,
  adaptiveSignals: { detailPreference: 0.5, directness: 0.5, technicalDepth: 0.5 },
};