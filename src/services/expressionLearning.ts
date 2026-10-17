// ================================================================
// Expression Learning Runtime — Learns HOW a user expresses themselves
// ================================================================
//
// Isolated from:
//   - languageLearning.ts (CEFR proficiency)
//   - userMemory.ts (preferences/requirements)
//   - knowledge (region knowledge base)
//
// Pipeline: observe -> authorship filter -> feature extraction ->
//           confidence reinforcement -> profile update -> prompt context
//
// NEVER blocks or crashes the main chat flow.

import { prisma } from './db';

// ==================== Tunables ====================

const CONFIDENCE_START = 0.3;
const CONFIDENCE_INCREMENT = 0.12;
const CONFIDENCE_MAX = 0.95;
const ACTIVE_CONFIDENCE = 0.5;
const ACTIVE_EVIDENCE = 3;
const MAX_PATTERNS_PER_MESSAGE = 12;
const DECAY_HALFLIFE_DAYS = 60;
const DISABLE_AFTER_DAYS = 180;

const STRENGTH_OFF = 0;
const STRENGTH_SUBTLE = 1;
const STRENGTH_NATURAL = 2;
const STRENGTH_STRONG = 3;

// ==================== Types ====================

export interface AuthorshipResult {
  isUserAuthored: boolean;
  reason: string;
}

export interface ExtractedFeature {
  dimension: string;
  pattern: string;
  meaning?: string;
  contextHint?: string;
}

export interface LearnedPattern {
  dimension: string;
  pattern: string;
  meaning?: string | null;
  confidence: number;
  evidenceCount: number;
  status: string;
}

export interface ExpressionContext {
  adaptationStrength: number;
  styleTone: string;
  primaryLanguage: string;
  confidence: number;
  patterns: { dimension: string; pattern: string; meaning?: string | null; contextHint?: string | null; confidence: number; evidenceCount: number; status: string }[];
  emojis: { emoji: string; meaning: string; sentiment: string; confidence: number }[];
  dialects: { term: string; dialect: string; scope: string; confidence: number }[];
}

export interface FeedbackInput {
  action: 'correct' | 'disable' | 'adjust' | 'confirm' | 'reject';
  patternId?: string;
  targetPattern?: string;
  correction?: string;
  note?: string;
}

// ==================== Dictionaries ====================

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'are', 'but', 'not', 'with', 'this', 'that', 'have',
  'from', 'they', 'will', 'would', 'there', 'their', 'what', 'when', 'your',
  'about', 'which', 'these', 'those', 'then', 'than', 'them', 'into', 'also',
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '那', '这个', '那个', '就是', '可以', '因为', '所以', '但是',
]);

const ABBREVIATIONS = new Set([
  'u', 'ur', 'pls', 'plz', 'thx', 'thnx', 'btw', 'imo', 'imho', 'tbh', 'lol',
  'rn', 'idk', 'afaik', 'asap', 'fyi', 'np', 'omg', 'wtf', 'btc', 'yyds',
  'xswl', 'zqsg', 'nsdd', 'awsl', 'dbq', 'xdm', 'u1s1', 'dddd',
]);

// 常见缩写/网络词的“意思”。用于“用前先确认含义”：收录的给确定释义，
// 未收录的词在注入时标为“未确认”，要求模型先用上下文推断或向用户确认再使用。
const ABBREV_MEANINGS: Record<string, string> = {
  u: 'you（你）', ur: 'your（你的）',
  pls: 'please（请）', plz: 'please（请）',
  thx: 'thanks（谢谢）', thnx: 'thanks（谢谢）',
  btw: 'by the way（顺便说）', imo: 'in my opinion（我觉得）',
  imho: 'in my humble opinion（我拙见）', tbh: 'to be honest（说实话）',
  rn: 'right now（现在）', idk: "I don't know（不知道）",
  afaik: 'as far as I know（据我所知）', asap: 'as soon as possible（尽快）',
  fyi: 'for your information（供参考）', np: 'no problem（没问题）',
  omg: 'oh my god（天哪）', wtf: 'what the f***（什么情况，粗口）',
  lol: 'laugh out loud（大笑）', btc: 'bitcoin（比特币）',
  yyds: '永远的神（夸赞）', xswl: '笑死我了', zqsg: '真情实感',
  nsdd: '你说得对', awsl: '啊我死了（夸张/可爱）',
  dbq: '顶不住', xdm: '兄弟们', dddd: '懂懂懂（懂了）', u1s1: '有一点点',
};

const CATCHPHRASE_SUFFIXES = [
  '啦', '咯', '喔', '呀', '咧', '嘛', '呗', '哈', '吼', '捏', '滴', 'der',
  'la', 'lah', 'lor', 'leh', 'le', 'liao', 'sia', 'mah', 'meh', 'kan',
];

const SENTENCE_MARKERS = [
  '我觉得', '我寻思', '话说', '讲真', '老实说', '不是我说', '有一说一',
  '怎么说呢', '就', '反正', '说白了', 'i think', 'honestly', 'actually',
  'to be honest', 'imo',
];

const DIALECT_MARKERS: { dialect: string; region: string; terms: string[] }[] = [
  { dialect: 'cantonese', region: 'HK/MO/GD', terms: ['咁', '嘅', '係', '唔', '啲', '喺', '嘢', '攞', '睇', '乜', '冇', '俾', '嗰', '點解'] },
  { dialect: 'mandarin_colloquial', region: 'CN', terms: ['咋', '啥', '忒', '贼', '整', '搞'] },
  { dialect: 'manglish', region: 'MY/SG', terms: ['lah', 'lor', 'leh', 'liao', 'sia', 'mah', 'meh', 'kan'] },
];

const SCENE_PATTERNS: { scene: string; patterns: RegExp[] }[] = [
  { scene: 'greeting', patterns: [/^(hi|hello|hey|早上好|早安|你好|在吗|在么)\b/i] },
  { scene: 'farewell', patterns: [/(拜拜|晚安|再见|回聊|see you|bye)/i] },
  { scene: 'request', patterns: [/(帮我|帮忙|请|能不能|可以.*吗|麻烦|help me|can you|could you)/i] },
  { scene: 'complaint', patterns: [/(不行|太差|为什么还|怎么还|有bug|报错|问题|崩了|又错了)/i] },
  { scene: 'praise', patterns: [/(厉害|牛逼|不错|太好了|good|great|awesome|nice)/i] },
  { scene: 'confirmation', patterns: [/^(好的|好|ok|okay|收到|行|嗯嗯|可以|没问题)\b/i] },
  { scene: 'question', patterns: [/\?\s*$/, /？\s*$/] },
];

const TONE_MARKERS: { tone: string; patterns: RegExp[] }[] = [
  { tone: 'playful', patterns: [/(哈哈|嘿嘿|嘻嘻|笑死|lol|haha|😂|🤣|😄)/i] },
  { tone: 'frustrated', patterns: [/(唉|哎|服了|气死|烦|无语|醉了|sigh|ugh)/i] },
  { tone: 'excited', patterns: [/(太好了|牛逼|冲|绝了|卧槽|!!!|！{3})/i] },
  { tone: 'polite', patterns: [/(谢谢|感谢|麻烦|请|thanks|please|appreciate)/i] },
];

// ==================== Authorship Detection ====================

export function detectAuthorship(message: string): AuthorshipResult {
  const trimmed = message.trim();
  if (!trimmed) return { isUserAuthored: false, reason: 'empty' };

  const codeFenceRatio = countMatches(trimmed, /```[\s\S]*?```/g) / Math.max(trimmed.length, 1);
  if (codeFenceRatio > 0.5) return { isUserAuthored: false, reason: 'mostly_code_block' };

  const lines = trimmed.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length > 3) {
    const quoted = lines.filter((l) => /^\s*>/.test(l)).length;
    if (quoted / lines.length > 0.6) return { isUserAuthored: false, reason: 'mostly_quoted' };
  }

  const urlRatio = countMatches(trimmed, /https?:\/\/\S+/g) / Math.max(trimmed.split(/\s+/).length, 1);
  if (urlRatio > 0.4) return { isUserAuthored: false, reason: 'mostly_urls' };

  const headingCount = (trimmed.match(/^#{1,6}\s+/gm) || []).length;
  if (headingCount >= 3 && trimmed.length > 400) {
    return { isUserAuthored: false, reason: 'document_like' };
  }

  return { isUserAuthored: true, reason: 'ok' };
}

export function stripNonUserContent(message: string): string {
  let text = message;
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`[^`]*`/g, ' ');
  text = text.replace(/https?:\/\/\S+/g, ' ');
  text = text.replace(/^\s*>.*$/gm, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

// ==================== Language ====================

export function detectExpressionLanguage(message: string, fallback = 'zh'): string {
  const latin = (message.match(/[a-zA-Z]/g) || []).length;
  const cjk = (message.match(/[\u4e00-\u9fff]/g) || []).length;
  const total = latin + cjk;
  if (total === 0) return fallback;
  if (cjk / total > 0.3) return 'zh';
  return 'en';
}

// ==================== Feature Extraction ====================

export function extractFeatures(text: string): ExtractedFeature[] {
  const features: ExtractedFeature[] = [];
  const seen = new Set<string>();
  const push = (f: ExtractedFeature) => {
    const key = `${f.dimension}:${f.pattern}`;
    if (seen.has(key) || f.pattern.length < 1) return;
    seen.add(key);
    features.push(f);
  };

  for (const m of text.matchAll(/([\u4e00-\u9fa5])\1{1,}/g)) {
    push({ dimension: 'catchphrase', pattern: m[0], contextHint: 'repeated_char' });
  }
  for (const m of text.matchAll(/([a-zA-Z])\1{2,}/gi)) {
    if (m[0].length <= 6) push({ dimension: 'catchphrase', pattern: m[0].toLowerCase(), contextHint: 'repeated_char' });
  }

  for (const p of ['!!!', '!!!', '！！', '？？', '。。。', '……', '~~', '!?', '？！']) {
    if (text.includes(p)) push({ dimension: 'punctuation', pattern: p });
  }

  for (const suffix of CATCHPHRASE_SUFFIXES) {
    const re = new RegExp(`[\\u4e00-\\u9fff]${escapeRegExp(suffix)}(?=[\\s,.!?，。！？]|$)`, 'g');
    const m = text.match(re);
    if (m) push({ dimension: 'sentence_pattern', pattern: suffix, contextHint: 'trailing_particle' });
  }

  for (const marker of SENTENCE_MARKERS) {
    if (text.toLowerCase().includes(marker.toLowerCase())) {
      push({ dimension: 'sentence_pattern', pattern: marker, contextHint: 'discourse_marker' });
    }
  }

  const tokens = text
    .toLowerCase()
    .split(/[\s,，。.!！?？;；:：""''（）()\[\]{}<>\n\t]+/)
    .filter(Boolean);

  const { scene } = detectScene(text);
  // 邻近词共现（“常和谁搭配” → 词汇拼接方法）
  const collocated = (word: string): string[] => {
    const cnt: Record<string, number> = {};
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== word) continue;
      for (let j = i - 2; j <= i + 2; j++) {
        const n = tokens[j];
        if (!n || n === word || n.length < 2 || n.length > 8) continue;
        if (STOPWORDS.has(n) || /^\d+$/.test(n)) continue;
        if (!/[\u4e00-\u9fff]/.test(n) && !/^[a-z]/.test(n)) continue; // 只要 CJK/字母词，排除 emoji/符号
        cnt[n] = (cnt[n] || 0) + 1;
      }
    }
    return Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
  };
  const hintFor = (coll: string[]): string =>
    [`场合:${scene}`, coll.length ? `搭配:${coll.join('、')}` : ''].filter(Boolean).join('; ');

  for (const t of tokens) {
    if (ABBREVIATIONS.has(t)) {
      push({ dimension: 'abbreviation', pattern: t, meaning: ABBREV_MEANINGS[t], contextHint: hintFor(collocated(t)) });
      continue;
    }
    const isCjk = /[\u4e00-\u9fff]/.test(t);
    const minLen = isCjk ? 2 : 4;
    if (t.length < minLen || STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    if (isCjk && t.length > 6) continue; // 无分词：过长的 CJK 串是短语/整句，不当“词”学
    // 生僻/个性化词：meaning 留空 → 注入时标为“未确认，用前先推断/确认”
    push({ dimension: 'vocabulary', pattern: t, contextHint: hintFor(collocated(t)) });
  }

  return features.slice(0, MAX_PATTERNS_PER_MESSAGE);
}

export function extractEmojis(text: string): { emoji: string; sentiment: string; intensity: number }[] {
  const emojis = text.match(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,
  ) || [];
  const positive = /[\u{1F600}-\u{1F64F}\u{1F970}-\u{1F97A}\u{2764}\u{2728}\u{1F525}\u{1F44D}]/u;
  const negative = /[\u{1F620}-\u{1F64F}\u{1F62D}\u{1F614}\u{1F92E}]/u;

  const out: { emoji: string; sentiment: string; intensity: number }[] = [];
  for (const e of emojis) {
    let sentiment = 'neutral';
    if (positive.test(e)) sentiment = 'positive';
    if (negative.test(e)) sentiment = 'negative';
    out.push({ emoji: e, sentiment, intensity: 0.6 });
  }
  return out;
}

export function classifyDialect(term: string): { dialect: string; region: string | null; scope: string } {
  const lower = term.toLowerCase();
  for (const marker of DIALECT_MARKERS) {
    if (marker.terms.some((t) => t.toLowerCase() === lower)) {
      return { dialect: marker.dialect, region: marker.region, scope: 'regional' };
    }
  }
  return { dialect: 'unknown', region: null, scope: 'personal' };
}

export function detectScene(text: string): { scene: string; tone: string } {
  let scene = 'statement';
  for (const s of SCENE_PATTERNS) {
    if (s.patterns.some((p) => p.test(text))) {
      scene = s.scene;
      break;
    }
  }
  let tone = 'neutral';
  for (const t of TONE_MARKERS) {
    if (t.patterns.some((p) => p.test(text))) {
      tone = t.tone;
      break;
    }
  }
  return { scene, tone };
}

// ==================== Profile & Learning ====================

async function getOrCreateProfile(userId: string, language: string) {
  const existing = await prisma.expressionProfile.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.expressionProfile.create({
    data: { userId, primaryLanguage: language },
  });
}

export async function learnFromUserMessage(
  userId: string,
  message: string,
  opts?: { language?: string },
): Promise<{ learned: number; skipped: boolean; reason?: string }> {
  const authorship = detectAuthorship(message);
  if (!authorship.isUserAuthored) {
    return { learned: 0, skipped: true, reason: authorship.reason };
  }

  const text = stripNonUserContent(message);
  if (text.length < 2) return { learned: 0, skipped: true, reason: 'too_short' };

  const language = detectExpressionLanguage(text, opts?.language || 'zh');

  try {
    const profile = await getOrCreateProfile(userId, language);
    if (profile.status !== 'active') return { learned: 0, skipped: true, reason: 'profile_inactive' };

    const features = extractFeatures(text);
    let learned = 0;
    for (const f of features) {
      const ok = await reinforcePattern(profile.id, f, 'observed').catch(() => false);
      if (ok) learned++;
    }

    await learnEmojis(profile.id, text).catch(() => {});
    await learnDialects(profile.id, text, language).catch(() => {});
    await learnContext(profile.id, text).catch(() => {});

    const count = features.length + 1;
    const newConfidence = Math.min(CONFIDENCE_MAX, profile.confidence + 0.02);
    await prisma.expressionProfile.update({
      where: { id: profile.id },
      data: {
        evidenceCount: { increment: count },
        confidence: newConfidence,
        primaryLanguage: language,
        lastObservedAt: new Date(),
      },
    });

    return { learned, skipped: false };
  } catch (err) {
    console.error('[ExpressionLearning] learnFromUserMessage error:', err);
    return { learned: 0, skipped: true, reason: 'error' };
  }
}

async function reinforcePattern(
  profileId: string,
  feature: ExtractedFeature,
  source: string,
): Promise<boolean> {
  const existing = await prisma.expressionPattern.findUnique({
    where: {
      expressionProfileId_dimension_pattern: {
        expressionProfileId: profileId,
        dimension: feature.dimension,
        pattern: feature.pattern,
      },
    },
  });

  if (existing) {
    if (existing.status === 'disabled' || existing.status === 'superseded') return false;
    const evidenceCount = existing.evidenceCount + 1;
    const confidence = Math.min(CONFIDENCE_MAX, existing.confidence + CONFIDENCE_INCREMENT);
    const status =
      confidence >= ACTIVE_CONFIDENCE && evidenceCount >= ACTIVE_EVIDENCE ? 'active' : 'learning';
    await prisma.expressionPattern.update({
      where: { id: existing.id },
      data: {
        evidenceCount,
        confidence,
        status,
        meaning: feature.meaning ?? existing.meaning,
        contextHint: feature.contextHint ?? existing.contextHint,
        lastSeenAt: new Date(),
        lastReinforcedAt: new Date(),
        expiresAt: null,
      },
    });
    return true;
  }

  await prisma.expressionPattern.create({
    data: {
      expressionProfileId: profileId,
      dimension: feature.dimension,
      pattern: feature.pattern,
      meaning: feature.meaning,
      contextHint: feature.contextHint,
      confidence: CONFIDENCE_START,
      evidenceCount: 1,
      source,
      status: 'learning',
    },
  });
  return true;
}

async function learnEmojis(profileId: string, text: string): Promise<void> {
  const emojis = extractEmojis(text);
  for (const e of emojis) {
    const existing = await prisma.emojiSemantic.findUnique({
      where: { expressionProfileId_emoji: { expressionProfileId: profileId, emoji: e.emoji } },
    });
    if (existing) {
      if (existing.status === 'disabled') continue;
      const usageCount = existing.usageCount + 1;
      const confidence = Math.min(CONFIDENCE_MAX, existing.confidence + CONFIDENCE_INCREMENT);
      const status = confidence >= ACTIVE_CONFIDENCE && usageCount >= ACTIVE_EVIDENCE ? 'active' : 'learning';
      await prisma.emojiSemantic.update({
        where: { id: existing.id },
        data: { usageCount, confidence, status, lastSeenAt: new Date() },
      });
    } else {
      await prisma.emojiSemantic.create({
        data: {
          expressionProfileId: profileId,
          emoji: e.emoji,
          meaning: e.sentiment,
          sentiment: e.sentiment,
          intensity: e.intensity,
          confidence: CONFIDENCE_START,
          status: 'learning',
        },
      });
    }
  }
}

async function learnDialects(profileId: string, text: string, language: string): Promise<void> {
  const tokens = text
    .toLowerCase()
    .split(/[\s,，。.!！?？;；:：""''（）()\[\]{}<>\n\t]+/)
    .filter(Boolean);
  for (const term of new Set(tokens)) {
    const cls = classifyDialect(term);
    if (cls.dialect === 'unknown') continue;
    const existing = await prisma.dialectOccurrence.findUnique({
      where: { expressionProfileId_term: { expressionProfileId: profileId, term } },
    });
    if (existing) {
      if (existing.status === 'disabled') continue;
      const occurrenceCount = existing.occurrenceCount + 1;
      const confidence = Math.min(CONFIDENCE_MAX, existing.confidence + CONFIDENCE_INCREMENT);
      const status = confidence >= ACTIVE_CONFIDENCE && occurrenceCount >= ACTIVE_EVIDENCE ? 'active' : 'learning';
      await prisma.dialectOccurrence.update({
        where: { id: existing.id },
        data: { occurrenceCount, confidence, status, lastSeenAt: new Date() },
      });
    } else {
      await prisma.dialectOccurrence.create({
        data: {
          expressionProfileId: profileId,
          term,
          dialect: cls.dialect,
          scope: cls.scope,
          region: cls.region,
          confidence: CONFIDENCE_START,
          status: 'learning',
        },
      });
    }
  }
}

async function learnContext(profileId: string, text: string): Promise<void> {
  const { scene, tone } = detectScene(text);
  if (scene === 'statement' && tone === 'neutral') return;

  const expression = text.slice(0, 80);
  const existing = await prisma.contextPattern.findFirst({
    where: { expressionProfileId: profileId, expression },
  });
  if (existing) {
    const occurrenceCount = existing.occurrenceCount + 1;
    const confidence = Math.min(CONFIDENCE_MAX, existing.confidence + CONFIDENCE_INCREMENT);
    const status = confidence >= ACTIVE_CONFIDENCE && occurrenceCount >= ACTIVE_EVIDENCE ? 'active' : 'learning';
    await prisma.contextPattern.update({
      where: { id: existing.id },
      data: { occurrenceCount, confidence, status, tone, lastSeenAt: new Date() },
    });
    return;
  }

  await prisma.contextPattern.create({
    data: {
      expressionProfileId: profileId,
      expression,
      scene,
      tone,
      confidence: CONFIDENCE_START,
      status: 'learning',
    },
  });
}

// ==================== Read & Prompt Context ====================

export async function getExpressionContext(userId: string): Promise<ExpressionContext | null> {
  try {
    const profile = await prisma.expressionProfile.findUnique({
      where: { userId },
      include: {
        patterns: { where: { status: { in: ['active', 'learning'] } }, orderBy: { confidence: 'desc' }, take: 40 },
        emojis: { where: { status: { in: ['active', 'learning'] } }, orderBy: { confidence: 'desc' }, take: 10 },
        dialects: { where: { status: { in: ['active', 'learning'] } }, orderBy: { confidence: 'desc' }, take: 10 },
      },
    });
    if (!profile) return null;

    return {
      adaptationStrength: profile.adaptationStrength,
      styleTone: profile.styleTone,
      primaryLanguage: profile.primaryLanguage,
      confidence: profile.confidence,
      patterns: profile.patterns.map((p) => ({
        dimension: p.dimension,
        pattern: p.pattern,
        meaning: p.meaning,
        contextHint: p.contextHint,
        confidence: p.confidence,
        evidenceCount: p.evidenceCount,
        status: p.status,
      })),
      emojis: profile.emojis.map((e) => ({
        emoji: e.emoji,
        meaning: e.meaning,
        sentiment: e.sentiment,
        confidence: e.confidence,
      })),
      dialects: profile.dialects.map((d) => ({
        term: d.term,
        dialect: d.dialect,
        scope: d.scope,
        confidence: d.confidence,
      })),
    };
  } catch {
    return null;
  }
}

export function selectInjectablePatterns(ctx: ExpressionContext): {
  patterns: { dimension: string; pattern: string; meaning?: string | null; contextHint?: string | null }[];
  emojis: { emoji: string; meaning: string; sentiment: string }[];
  dialects: { term: string; dialect: string; scope: string }[];
} {
  const s = ctx.adaptationStrength;
  if (s <= STRENGTH_OFF) return { patterns: [], emojis: [], dialects: [] };

  const minConf = s === STRENGTH_SUBTLE ? 0.7 : s === STRENGTH_NATURAL ? ACTIVE_CONFIDENCE : 0.4;
  const maxPatterns = s === STRENGTH_SUBTLE ? 3 : s === STRENGTH_NATURAL ? 6 : 10;
  const maxEmojis = s === STRENGTH_SUBTLE ? 0 : s === STRENGTH_NATURAL ? 3 : 5;

  const usable = ctx.patterns
    .filter((p) => p.status === 'active' || (s === STRENGTH_STRONG && p.status === 'learning'))
    .filter((p) => p.confidence >= minConf)
    .filter((p) => {
      if (p.dimension !== 'vocabulary') return true;
      return s >= STRENGTH_STRONG || (s >= STRENGTH_NATURAL && p.confidence >= 0.6);
    })
    .slice(0, maxPatterns)
    .map((p) => ({ dimension: p.dimension, pattern: p.pattern, meaning: p.meaning, contextHint: p.contextHint }));

  return {
    patterns: usable,
    emojis: ctx.emojis
      .filter((e) => e.confidence >= minConf)
      .slice(0, maxEmojis),
    dialects:
      s >= STRENGTH_NATURAL
        ? ctx.dialects.filter((d) => d.confidence >= ACTIVE_CONFIDENCE).slice(0, 4)
        : [],
  };
}

// 从 contextHint（“场合:X; 搭配:Y”）解析出使用场合与拼接（共现）两部分
function parseHint(hint?: string | null): { scene?: string; collocated?: string } {
  if (!hint) return {};
  const out: { scene?: string; collocated?: string } = {};
  const s = hint.match(/场合[:：]\s*([^;；]+)/);
  const c = hint.match(/搭配[:：]\s*([^;；]+)/);
  if (s && s[1] && s[1].trim()) out.scene = s[1].trim();
  if (c && c[1] && c[1].trim()) out.collocated = c[1].trim();
  return out;
}

export function buildExpressionSection(
  ctx: ExpressionContext,
  selected?: ReturnType<typeof selectInjectablePatterns>,
): string {
  const sel = selected || selectInjectablePatterns(ctx);
  if (ctx.adaptationStrength <= STRENGTH_OFF) return '';

  const lines: string[] = ['[User Expression Style]'];
  lines.push(`Adaptation strength: ${ctx.adaptationStrength}/3 (${strengthLabel(ctx.adaptationStrength)})`);
  lines.push(`Preferred tone: ${ctx.styleTone}`);

  if (sel.patterns.length > 0) {
    lines.push('Words/phrases this user actually uses — understand each before using it:');
    for (const p of sel.patterns) {
      const hint = parseHint(p.contextHint);
      lines.push(`- "${p.pattern}"`);
      lines.push(
        p.meaning
          ? `    意思: ${p.meaning}`
          : '    意思: （未确认 — 使用前先按上下文推断其含义，拿不准就别用）',
      );
      if (hint.scene) lines.push(`    场合: ${hint.scene}`);
      if (hint.collocated) lines.push(`    搭配: 常与「${hint.collocated}」一起出现，按此方式自然嵌入句子`);
    }
  }
  if (sel.emojis.length > 0) {
    lines.push('Emoji usage:');
    for (const e of sel.emojis) lines.push(`- ${e.emoji} = ${e.meaning}`);
  }
  if (sel.dialects.length > 0) {
    lines.push('Dialect/region terms:');
    for (const d of sel.dialects) lines.push(`- ${d.term} (${d.dialect}, ${d.scope})`);
  }

  lines.push(
    'Rules: before using any word above, confirm you understand its 意思 (if marked 未确认, infer from context or ask, else skip); ' +
      'use it only in the stated 场合; ' +
      'when 搭配 is given, weave it in with those words so the sentence reads natural, never bolt words on; ' +
      'carry at most one or two such markers per reply; ' +
      'mirror the user naturally, never imitate to flatter or impersonate.',
  );
  lines.push(
    'Style goal (on top of the habits above): keep replies human, warm, and easy to follow — carry a little genuine feeling that fits the moment, but stay sincere, never sycophantic or over-the-top.',
  );

  return lines.join('\n');
}

function strengthLabel(s: number): string {
  if (s <= STRENGTH_OFF) return 'off';
  if (s === STRENGTH_SUBTLE) return 'subtle';
  if (s === STRENGTH_NATURAL) return 'natural';
  return 'strong';
}

// 地区共享习惯段（个人习惯优先级高于地区）
export function buildRegionSection(habits: { dimension: string; pattern: string }[]): string {
  if (!habits.length) return '';
  const lines: string[] = ['[Region Shared Habits] — 该地区通用，个人习惯优先于地区:'];
  for (const h of habits) lines.push(`- [${h.dimension}] ${h.pattern}`);
  lines.push('若与上文 [User Expression Style] 的个人习惯冲突，以个人为准。');
  return lines.join('\n');
}

// ==================== Anti-Imitation Check ====================

export interface ImitationCheckResult {
  ok: boolean;
  density: number;
  repeated: string[];
  note?: string;
}

export function antiImitationCheck(
  generatedText: string,
  injected: { pattern: string }[],
): ImitationCheckResult {
  if (injected.length === 0) return { ok: true, density: 0, repeated: [] };
  const lower = generatedText.toLowerCase();
  const repeated: string[] = [];

  for (const p of injected) {
    const token = p.pattern.toLowerCase();
    if (!token) continue;
    const count = lower.split(token).length - 1;
    if (count >= 3) repeated.push(p.pattern);
  }

  const markedCount = injected.filter((p) => lower.includes(p.pattern.toLowerCase())).length;
  const density = generatedText.length > 0 ? markedCount / Math.max(generatedText.length / 100, 1) : 0;
  const ok = repeated.length === 0 && density <= 3;

  return {
    ok,
    density,
    repeated,
    note: ok ? undefined : 'stylistic over-imitation detected',
  };
}

// ==================== Feedback & Control ====================

export async function applyFeedback(userId: string, input: FeedbackInput): Promise<boolean> {
  try {
    const profile = await prisma.expressionProfile.findUnique({ where: { userId } });
    if (!profile) return false;

    if (input.action === 'disable' || input.action === 'reject') {
      if (input.patternId) {
        const p = await prisma.expressionPattern.findUnique({ where: { id: input.patternId } });
        if (p && p.expressionProfileId === profile.id) {
          await prisma.expressionPattern.update({ where: { id: p.id }, data: { status: 'disabled' } });
        }
      } else if (input.targetPattern) {
        await prisma.expressionPattern.updateMany({
          where: { expressionProfileId: profile.id, pattern: input.targetPattern },
          data: { status: 'disabled' },
        });
      }
    }

    if (input.action === 'correct' && input.targetPattern && input.correction) {
      await prisma.expressionPattern.updateMany({
        where: { expressionProfileId: profile.id, pattern: input.targetPattern },
        data: { meaning: input.correction, source: 'corrected', status: 'active', confidence: 0.8 },
      });
    }

    if (input.action === 'adjust' && input.correction) {
      const val = parseInt(input.correction, 10);
      if (!Number.isNaN(val) && val >= 0 && val <= 3) {
        await prisma.expressionProfile.update({
          where: { id: profile.id },
          data: { adaptationStrength: val },
        });
      }
    }

    await prisma.expressionFeedback.create({
      data: {
        expressionProfileId: profile.id,
        patternId: input.patternId,
        action: input.action,
        targetPattern: input.targetPattern,
        correction: input.correction,
        note: input.note,
        applied: true,
      },
    });

    return true;
  } catch (err) {
    console.error('[ExpressionLearning] applyFeedback error:', err);
    return false;
  }
}

export async function setAdaptationStrength(userId: string, strength: number): Promise<boolean> {
  try {
    const val = Math.max(0, Math.min(3, Math.round(strength)));
    const profile = await prisma.expressionProfile.findUnique({ where: { userId } });
    if (!profile) return false;
    await prisma.expressionProfile.update({ where: { id: profile.id }, data: { adaptationStrength: val } });
    return true;
  } catch {
    return false;
  }
}

export async function deletePattern(userId: string, patternId: string): Promise<boolean> {
  try {
    const profile = await prisma.expressionProfile.findUnique({ where: { userId } });
    if (!profile) return false;
    const p = await prisma.expressionPattern.findUnique({ where: { id: patternId } });
    if (!p || p.expressionProfileId !== profile.id) return false;
    await prisma.expressionPattern.update({ where: { id: p.id }, data: { status: 'disabled' } });
    return true;
  } catch {
    return false;
  }
}

// ==================== Decay ====================

export async function applyExpressionDecay(userId: string): Promise<{ halved: number; disabled: number }> {
  try {
    const profile = await prisma.expressionProfile.findUnique({ where: { userId } });
    if (!profile) return { halved: 0, disabled: 0 };

    const patterns = await prisma.expressionPattern.findMany({
      where: { expressionProfileId: profile.id, status: { in: ['active', 'learning'] } },
    });

    const now = Date.now();
    let halved = 0;
    let disabled = 0;

    for (const p of patterns) {
      const days = (now - p.lastSeenAt.getTime()) / (1000 * 60 * 60 * 24);
      if (days >= DISABLE_AFTER_DAYS) {
        await prisma.expressionPattern.update({ where: { id: p.id }, data: { status: 'disabled' } });
        disabled++;
      } else if (days >= DECAY_HALFLIFE_DAYS) {
        await prisma.expressionPattern.update({
          where: { id: p.id },
          data: { confidence: Math.max(0, p.confidence * 0.5), status: 'learning' },
        });
        halved++;
      }
    }

    const profileDays = profile.lastObservedAt
      ? (now - profile.lastObservedAt.getTime()) / (1000 * 60 * 60 * 24)
      : 0;
    if (profileDays >= DECAY_HALFLIFE_DAYS) {
      await prisma.expressionProfile.update({
        where: { id: profile.id },
        data: { confidence: Math.max(0, profile.confidence * 0.5) },
      });
    }

    return { halved, disabled };
  } catch (err) {
    console.error('[ExpressionLearning] applyExpressionDecay error:', err);
    return { halved: 0, disabled: 0 };
  }
}

// ==================== Helpers ====================

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.reduce((s, x) => s + x.length, 0) : 0;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
