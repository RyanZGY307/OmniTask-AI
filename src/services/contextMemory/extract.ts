// ================================================================
// Context Memory — event extraction (deterministic, zero-AI).
//
// Runs synchronously in the realtime path, right after the user
// message is persisted. It extracts high-value signals from the
// CURRENT message + a short recent-history window:
//   - corrections (factual / task / preference / opinion / requirement)
//   - requirements, preferences, task-stage changes, decisions
//   - references ("第二个方案", "这个文件", ordinals, artifact ids)
//   - capability intents (image/video/audio/ppt/file) — kept intact
//     so Context Memory can never break media generation triggers
//
// All heuristics are rule-based and testable; no LLM call happens
// here (spec: "Context Memory 主要由规则、存储、检索和必要的异步
// 压缩任务管理").
// ================================================================

import type {
  CorrectionKind,
  CorrectionSignal,
  ContextReference,
  ContextAwareIntentResult,
} from './types';

export interface ExtractionInput {
  message: string;
  messageId: string;
  recentHistory: Array<{ role: string; content: string; messageId?: string }>;
  conversationArtifacts?: string[]; // artifact/file ids present in the conversation
  scenarioId?: string | null;
}

// ==================== Capability intents (spec cases 12-16) ====================

const CAPABILITY_PATTERNS: Array<{ cap: string; re: RegExp }> = [
  { cap: 'image_generation', re: /(?:生成|画|做|来|创建|produce|generate|create|make|draw)\s*(?:一张|一个|几|些)?\s*(?:图片|图像|照片|插画|海报|头像|图样)|生成.*图片|image\s*(?:generation|gen)|生成\s*image/i },
  { cap: 'video_generation', re: /(?:生成|做|制作|来|转|变成|produce|generate|make|turn|convert)\s*(?:成|为)?\s*(?:一段|一个|部)?\s*(?:视频|影片|短片|动画|视频片段)|video\s*(?:generation|gen)|做成.*视频/i },
  { cap: 'audio_generation', re: /(?:生成|做|制作|来|合成|produce|generate|make|synth)\s*(?:一段|一个|部)?\s*(?:音频|音乐|语音|人声|配音|声音)|audio\s*(?:generation|gen)|生成.*音频/i },
  { cap: 'presentation_generation', re: /(?:生成|做|制作|来|写|produce|generate|make|create)\s*(?:一份|一个|套|页)?\s*(?:PPT|幻灯片|演示文稿|deck)|presentation\s*(?:generation|gen)|生成\s*(?:一份|一个|个)?\s*PPT/i },
  { cap: 'file_modification', re: /(?:修改|改一下|改下|调整|重构|修复|修一下|change|modify|fix|refactor|adjust|update|patch).{0,10}?(?:代码|文件|项目|脚本|文档|模块|代码库|工程|file|code|project|script|doc|repo|program)|(?:代码|文件|项目|脚本|文档|模块|代码库|工程|file|code|project).{0,6}?(?:修改|改一下|调整|重构|修复|change|modify|fix|refactor|adjust|update|patch)/i },
];

// Artifact required + in-app preview detection (spec 14/15/16)
const ARTIFACT_REQUIRED_RE = /(?:ZIP|打包|下载|给我|发给我|导出|交付|在这里听|在这里看|package|download|export|deliver|给我)/i;
const IN_APP_PREVIEW_RE = /(?:直接(?:在)?(?:这里|AI\s*里|AI里|app\s*里|app里|应用里|软件里|平台里|网页里|软件中|应用中)?\s*(?:看|预览|播放|听|打开)|在\s*(?:AI|app|应用|软件|这里)\s*(?:里面|里|中)?\s*(?:看|听|预览|打开)|in\.?\s*the?\s*app|here\s*in)/i;

// ==================== Correction detection ====================

// Correction lead-ins — the user is challenging/asserting against
// something previously stated. "我不同意" without a factual target is
// opinion, not factual correction.
const CORRECTION_LEADINS = /(?:不对|不是|错误|错的|你搞错|搞错|应该是|现在是|已经(?:变成|改到|更新到)?|更新为|纠正|更正|我不同意|不同意|correction|wrong|incorrect|actually|no,|not,|它不是|它现在是|it'?\s?s now|currently it)/i;

// Opinion disagreement — explicitly NOT factual (no web verification).
// Only when the user pushes back on an evaluation/opinion without a
// concrete factual counter-claim.
const OPINION_RE = /(?:我不同意|不同意你的|我觉得.*更好|我认为.*更好|个人觉得|opinion|disagree)/i;

// Factual counter-claim anchors: the user asserts a concrete version /
// value / state. Two shapes: (a) explicit version number "v4 / 4.0 / 4",
// (b) a named entity followed by a release marker "Y 已经发布了".
const FACTUAL_ANCHOR_RE = /(?:版本|version|最新|latest|价格|price|发布于|发布时间|released|日期|date|当前现状|现价|\$\s?\d+|现在是\s*[0-9A-Za-z]|现在是\s*已经|v?\d+(?:\.\d+)?\s*(?:发布|版本|released)|[^\s,。！？!？]{2,20}\s*(?:已经|已)\s*(?:发布|上线|更新|变成|改为|成|是|变为)\s*(?:了)?)/i;
const NUMBER_RE = /\d+(?:\.\d+)?/;

// Task correction: user redirects WHAT to do, not a fact.
const TASK_CORRECTION_RE = /(?:我要的是|我不是要|不是让你|别写代码|我要你|你理解错了|我的意思是|重新分析|按.*重新|instead.*analyze|not.*code|I want you to|I meant)/i;
const PREFERENCE_CORRECTION_RE = /(?:我更喜欢|我偏好|我希望(?:更|要)|喜欢更|prefer|I would rather|我其实更|我刚才说错|现在我要|我要完整|要详细|完整详细版|我要更)/i;
const REQUIREMENT_CHANGE_RE = /(?:必须|需要支持|要能|加一个|新增|要求|requirement|must|needs to|support|支持\s*(?:下载|导出|ZIP))(\S)/i;
const DECISION_RE = /(?:我决定|我们决定|确定|定下来|决定|final decision|I'?\s?ve decided|decided|最终|保留)/i;

function classifyCorrection(message: string, hasPriorAiOutput: boolean): { kind: CorrectionKind; verificationRequired: boolean } {
  const hasLeadIn = CORRECTION_LEADINS.test(message);
  const hasOpinion = OPINION_RE.test(message);
  // A "现在是 Y 了 / 已经变成 Y / Y 已经发布了" statement is a factual
  // claim about the world (a value change), even without a version word.
  const hasValueChange = /(?:现在是|已经(?:变成|改为|更新|成|是)|已变成|变成|不再是|已经发布|发布了)\s*[0-9A-Za-z一-龥]/.test(message)
    || /[0-9A-Za-z一-龥]{2,20}\s*(?:已经|已)\s*(?:发布|上线|更新|变成|改为|成|是|变为)/.test(message);
  const hasFact = FACTUAL_ANCHOR_RE.test(message) || hasValueChange;

  // Opinion disagreement ("我不同意你的评价") is never factual, even
  // with a lead-in.
  if (hasOpinion && !hasFact && !FACTUAL_ANCHOR_RE.test(message)) {
    return { kind: 'opinion', verificationRequired: false };
  }
  // Explicit "factual claim" against prior AI output -> factual correction
  if (hasPriorAiOutput && hasFact) {
    return { kind: 'factual', verificationRequired: true };
  }
  if (TASK_CORRECTION_RE.test(message)) {
    return { kind: 'task', verificationRequired: false };
  }
  if (PREFERENCE_CORRECTION_RE.test(message)) {
    return { kind: 'preference', verificationRequired: false };
  }
  if (REQUIREMENT_CHANGE_RE.test(message) && !DECISION_RE.test(message)) {
    return { kind: 'requirement', verificationRequired: false };
  }
// A lead-in without any factual anchor and without a task redirect is
// most likely an opinion disagreement ("我不同意你的评价"). But if it's
// a preference change (user is restating what they want, challenging a
// prior preference), classify as preference, not opinion.
if (hasLeadIn && !hasFact && !TASK_CORRECTION_RE.test(message)) {
  if (PREFERENCE_CORRECTION_RE.test(message)) {
    return { kind: 'preference', verificationRequired: false };
  }
  return { kind: 'opinion', verificationRequired: false };
}
  if (hasFact && hasLeadIn) {
    return { kind: 'factual', verificationRequired: true };
  }
  // Default fallback: treat as a requirement statement (new ask).
  return { kind: 'requirement', verificationRequired: false };
}

// ==================== Reference detection ====================

const ORDINALS: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'first': 1, 'second': 2, 'third': 3, 'fourth': 4, 'fifth': 5,
};

function detectReference(message: string, artifacts: string[], hasPriorAiOutput: boolean): ContextReference {
  const lower = message.toLowerCase();

  // Explicit artifact id mention: "artifact abc" / "文件 abc123"
  if (artifacts.length > 0) {
    for (const id of artifacts) {
      if (lower.includes(String(id).toLowerCase())) {
        return { targetType: 'artifact', targetId: id, summary: 'direct artifact id mentioned' };
      }
    }
  }

  // "这个/那个文件" with an artifact in scope -> artifact reference
  if (artifacts.length > 0 && /(?:这个|该|此|刚才|the)\s*(?:文件|artifact|项目|代码)/i.test(lower)) {
    return { targetType: 'artifact', targetId: artifacts[0], summary: 'proximity-based artifact reference' };
  }

  // Ordinal option reference: "第二个方案" / "第二个" / "option 2" / "the second one"
  const m = message.match(/(?:第|number|#|no\.?)\s*([一二三四五六七八九十]|10|[1-9]|first|second|third|fourth|fifth)\s*(?:个)?\s*(?:方案|选项|option|个|one|item)?/i);
  if (m && ORDINALS[m[1].toLowerCase()] !== undefined) {
    const ordinal = ORDINALS[m[1].toLowerCase()];
    return {
      targetType: 'ai_option',
      ordinal,
      summary: `referencing option #${ordinal} of the previous assistant output`,
    };
  }

  // Bare "这个/那个" with an artifact in scope
  if (artifacts.length > 0 && /(?:这个|那个|这个文件|that one|this one)/.test(message)) {
    return { targetType: 'artifact', targetId: artifacts[0], summary: 'demonstrative artifact reference' };
  }

  // "再详细一点" / "展开" / "继续" = continuation of the last AI output.
  const CONTINUATION_RE = /(?:再详细一点|详细一点|展开|继续|接着|然后呢|再多说|深入一点|再深入|expand|continue|go on|tell me more)/i;
  if (CONTINUATION_RE.test(message) && hasPriorAiOutput) {
    return { targetType: 'ai_output', summary: 'continuation of the previous assistant output' };
  }

  return { targetType: 'none' };
}

// ==================== Main extraction ====================

export interface ExtractionOutput {
  capability: string | null;
  artifactRequired: boolean;
  inAppPreview: boolean;
  correction: CorrectionSignal;
  requirementChange: boolean;
  preferenceChange: boolean;
  decisionMade: boolean;
  taskStageChange: string | null;
  reference: ContextReference;
  importance: number; // 0..1
}

export function extractEvents(input: ExtractionInput): ExtractionOutput {
  const { message, recentHistory, conversationArtifacts = [] } = input;
  const lastAi = [...recentHistory].reverse().find((h) => h.role === 'assistant');
  const hasPriorAi = !!lastAi?.content?.length;

  // --- capability intents first (must survive Context Memory) ---
  let capability: string | null = null;
  for (const p of CAPABILITY_PATTERNS) {
    if (p.re.test(message)) { capability = p.cap; break; }
  }
  const artifactRequired = !!capability && ARTIFACT_REQUIRED_RE.test(message);
  const inAppPreview = IN_APP_PREVIEW_RE.test(message);

  // --- correction classification ---
  const { kind, verificationRequired } = classifyCorrection(message, hasPriorAi);
  // A "correction" is detected when the user challenges/prior-contradicts.
  // The 'requirement' kind returned by classifyCorrection is the default
  // fallback (not a real correction), so detected=false unless the kind
  // is one of the true correction types.
  const correctionDetected = ['factual', 'task', 'preference', 'opinion'].includes(kind);
  const correction: CorrectionSignal = {
    detected: correctionDetected,
    kind,
    targetsPreviousAiOutput: correctionDetected ? hasPriorAi : false,
    verificationRequired: correctionDetected ? verificationRequired : false,
    claimSummary: hasPriorAi && kind === 'factual' ? String(lastAi!.content).slice(0, 200) : undefined,
    userClaim: kind === 'factual' ? message.slice(0, 200) : undefined,
  };

  const requirementChange = REQUIREMENT_CHANGE_RE.test(message) || /必须|要求|一定要/.test(message);
  const preferenceChange = PREFERENCE_CORRECTION_RE.test(message);
  const decisionMade = DECISION_RE.test(message);

  // --- task stage change ---
  let taskStageChange: string | null = null;
  if (/开始实现|开始写代码|开始编码|let'?\s?s start (?:implement|coding)|start implementing/i.test(message)) {
    taskStageChange = 'implementation';
  } else if (/(?:只|仅|先不)(?:要|讨论|设计)|discussion only|only (?:discuss|design)|先讨论/i.test(message)) {
    taskStageChange = 'discussion_only';
  } else if (/设计|架构方案|设计文档|design doc|architecture/i.test(message)) {
    taskStageChange = 'design';
  }

  const reference = detectReference(message, conversationArtifacts, hasPriorAi);

  // --- importance scoring (drives retention, not recency) ---
  let importance = 0.3;
  if (capability) importance = 0.9;
  if (correction.detected) importance = Math.max(importance, kind === 'factual' ? 0.95 : 0.7);
  if (requirementChange) importance = Math.max(importance, 0.8);
  if (preferenceChange) importance = Math.max(importance, 0.75);
  if (decisionMade) importance = Math.max(importance, 0.9);
  if (taskStageChange) importance = Math.max(importance, 0.85);
  if (reference.targetType !== 'none') importance = Math.max(importance, 0.6);
  if (/^你好|hello|hi|谢谢|thanks|好的|ok|明白|继续/i.test(message.trim())) importance = 0.05;

  return {
    capability,
    artifactRequired,
    inAppPreview,
    correction,
    requirementChange,
    preferenceChange,
    decisionMade,
    taskStageChange,
    reference,
    importance,
  };
}

// ==================== Context-Aware Intent merge ====================

// Merge the deterministic extraction with the existing AI classification
// into the context-aware intent result. The AI side (Context Analyzer /
// Scenario Runtime) keeps its role; this only ADDS context signals.
export function buildContextAwareIntent(
  aiClassification: { scenarios?: string[]; verification_required?: boolean } | null,
  extraction: ExtractionOutput,
  opts: {
    scenarioStable?: boolean;
    activeTask?: { task: string | null; stage: string | null; status: string; constraints: string[] } | null;
    openCorrections?: Array<{ kind: string; userClaim: string | null; status: string }>;
    recentRequirements?: string[];
    recentPreferences?: string[];
  },
): ContextAwareIntentResult {
  // Determine contextRelation from the extracted signals, in priority
  // order: true correction > requirement_change > preference_change >
  // reference/capability/continuation > new_request. Note: a preference
  // "correction" (user restating what they want) is a preference_change,
  // not a correction — so map correction.kind 'preference' accordingly.
  let contextRelation: ContextAwareIntentResult['contextRelation'] = 'new_request';
  if (extraction.correction.detected) {
    contextRelation = extraction.correction.kind === 'preference' ? 'preference_change' : 'correction';
  } else if (extraction.requirementChange) {
    contextRelation = 'requirement_change';
  } else if (extraction.preferenceChange) {
    contextRelation = 'preference_change';
  } else if (extraction.reference.targetType !== 'none' || extraction.capability) {
    contextRelation = 'reference';
  }

  return {
    contextRelation,
    requirementChange: extraction.requirementChange,
    preferenceChange: extraction.preferenceChange || extraction.correction.kind === 'preference',
    capabilityIntent: extraction.capability,
    artifactRequired: extraction.artifactRequired,
    inAppPreview: extraction.inAppPreview,
    reference: extraction.reference.targetType === 'none' ? null : extraction.reference,
    correction: extraction.correction,
    scenarioStable: opts.scenarioStable ?? !!aiClassification?.scenarios?.length,
    activeTask: opts.activeTask ?? null,
    openCorrections: opts.openCorrections ?? [],
    recentRequirements: opts.recentRequirements ?? [],
    recentPreferences: opts.recentPreferences ?? [],
  };
}
