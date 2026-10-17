// ================================================================
// Office Intent Gate — distinguishes "user wants to GENERATE an
// Office artifact" from ordinary Q&A / knowledge / explanation.
//
// A bare keyword ("PPTX 和 PPT 有什么区别？", "DOCX 是什么？",
// "XLOOKUP 怎么用？") must NOT open the spec card. Only a generation
// verb + an Office object triggers it.
//
// Mirrors the audio intent gate: deterministic regex + Context
// Reference for "刚刚那个转 PDF" (format transformation).
// ================================================================

export type OfficeIntentKind = 'presentation' | 'document' | 'spreadsheet';

export interface OfficeGateInput {
  message: string;
  history?: Array<{ role: string; content: string; messageId?: string }>;
}

export interface OfficeGateResult {
  shouldOpenCard: boolean;
  kind?: OfficeIntentKind;
  reason: 'generate_office' | 'transform' | 'not_generation' | 'general';
  autoFill?: {
    artifactType?: 'presentation' | 'document' | 'spreadsheet';
    format?: string;
    contentOverview?: string;
    title?: string;
    audience?: string;
    pageOrSlideCount?: number;
    documentType?: string;
    style?: string;
    // "刚刚那个 / 刚才那个 / 这份" + "转成 X / 导出 X / 给我 X 格式"
    sourceArtifactHint?: boolean;
    targetFormatHint?: string;
    // "第 N 页 / 第 N 张 / Sheet N / 第 N 节" → target reference
    targetRef?: { type: string; index?: number; name?: string };
    operation?: 'generate' | 'modify' | 'transform';
  };
}

// Generation verbs that unambiguously ask for an Office OUTPUT.
const GEN_VERB_RE =
  /(?:做|生成|创建|建立|来一份|来一份|写一份|写一个|帮我做|帮我生成|帮我写|整理成|输出|produce|generate|create|make|write|build)\s*(?:一个|一份|一张|一部|个|份|张|部)?\s*(.{0,40})/i;

// Office object nouns. The noun determines the artifact kind.
const PRESENTATION_NOUN_RE = /(?:ppt|演示文稿|幻灯片|幻灯|课件|演示|slides?|presentation|slides)/i;
const DOCUMENT_NOUN_RE =
  /(?:docx?|word|文档|报告|报告|需求文档|prd|说明|纪要|会议纪要|白皮书|手册|manual|document|report|whitepaper|spec|memo)/i;
const SPREADSHEET_NOUN_RE =
  /(?:xlsx?|excel|表格|数据表|工作表|报表|台账|工作表|spreadsheet|worksheet|pivot|data\s*table|表格)/i;

// Negatives: discussion / explanation / Q&A about the format.
// NOTE: the trailing \b is dropped for CJK alternatives (CJK has no word
// boundaries), so Chinese negative cues match reliably.
const NEGATIVE_RE =
  /(?:区别|对比|比较|是什么|什么是|怎么用|怎样用|如何用|方法|教程|支持哪些|原理|解释|定义|优缺点|哪个好)|(?:what\s+is|how\s+to|difference|explain|define|compare)\b/i;

// Explicit format tokens (user-specified format wins).
const FORMAT_TOKEN_RE =
  /\b(pptx?|docx?|xlsx?|pdf)\b/i;

// Page / slide count ("10 页", "12 张", "6 slides", "20 pages").
const PAGE_COUNT_RE = /(\d{1,3})\s*(?:页|张|slide|slides?|page|pages?)/i;

// Density cue ("简短", "concise") — NOT a page count.
const DENSITY_RE = /(?:简短|简洁|精简|concise|brief|短一点)/i;

// "刚刚那个 / 刚才 / 这份" + target format → transformation.
const SOURCE_REF_RE = /(?:刚刚(?:那个|的)?|刚才(?:那个|的)?|这份|那个|current|this\s+(?:document|file|presentation|workbook))/i;
// "转 PDF" / "转成 DOCX" / "给我 X 格式" — a bare 转 + a known format token
// is enough to mean "convert to that format".
const TRANSFORM_VERB_RE = /(?:转成|转换|导出|转为|变成|转|给我|to|export|convert)\s*(.{0,20})/i;

// Target references: "第 N 页 / 第 N 张 / Sheet N / 第 N 节".
const TARGET_PAGE_RE = /第\s*(\d{1,3})\s*(?:页|张|页码|slide|page)/i;
const TARGET_SHEET_RE = /sheet\s*(\d{1,3}|[A-Za-z]+)/i;
const TARGET_SECTION_RE = /第\s*(\d{1,3})\s*(?:节|章|部分)/i;

export function analyzeOfficeGenerationIntent(input: OfficeGateInput): OfficeGateResult {
  const msg = input.message;

  // Explicit negative → never open the card.
  if (NEGATIVE_RE.test(msg)) {
    return { shouldOpenCard: false, reason: 'not_generation' };
  }

  // Determine which Office object noun is present.
  const isPresentation = PRESENTATION_NOUN_RE.test(msg);
  const isDocument = DOCUMENT_NOUN_RE.test(msg);
  const isSpreadsheet = SPREADSHEET_NOUN_RE.test(msg);
  const anyNoun = isPresentation || isDocument || isSpreadsheet;

  const resolveKind = (): OfficeIntentKind =>
    isSpreadsheet ? 'spreadsheet' : isPresentation ? 'presentation' : 'document';

  // Format transformation: "刚刚那个转 PDF" — existing artifact → new format.
  // Transforms reference an EXISTING artifact, so they are not gated by
  // the generation-verb requirement; they are detected purely by
  // source-ref + transform-verb + an office noun (bare "转" is too weak).
  if (SOURCE_REF_RE.test(msg) && TRANSFORM_VERB_RE.test(msg) && anyNoun) {
    const target = (msg.match(FORMAT_TOKEN_RE)?.[1]?.toLowerCase()) as any;
    return {
      shouldOpenCard: true,
      kind: resolveKind(),
      reason: 'transform',
      autoFill: {
        artifactType: resolveKind(),
        format: target || undefined,
        sourceArtifactHint: true,
        targetFormatHint: target,
        operation: 'transform',
        targetRef: detectTargetRef(msg),
      },
    };
  }

  // Modification of an existing artifact ("第四页内容少一点", "改成 15 页").
  // Modifications target an existing section/sheet/page, so like transforms
  // they are detected by target-reference + edit-verb without a gen verb.
  const MODIFY_VERB_RE = /(?:少一点|多一点|改|换成|重新|调整|增加|删|加|改成|改为|修改|modify|change|edit|remove|add)/;
  const hasTargetRef = SOURCE_REF_RE.test(msg) || TARGET_PAGE_RE.test(msg) || TARGET_SHEET_RE.test(msg) || TARGET_SECTION_RE.test(msg);
  if (MODIFY_VERB_RE.test(msg) && hasTargetRef && anyNoun) {
    return {
      shouldOpenCard: true,
      kind: resolveKind(),
      reason: 'generate_office',
      autoFill: {
        artifactType: resolveKind(),
        format: (msg.match(FORMAT_TOKEN_RE)?.[1]?.toLowerCase()) as any,
        sourceArtifactHint: true,
        operation: 'modify',
        targetRef: detectTargetRef(msg),
        pageOrSlideCount: parsePageCount(msg),
        contentOverview: extractContentOverview(msg),
      },
    };
  }

  if (!anyNoun) {
    return { shouldOpenCard: false, reason: 'general' };
  }

  // A generation verb (or a strong "帮我做/生成" + noun) is required for
  // NEW-creation intents ("做一份" / "生成").
  const hasGenVerb = GEN_VERB_RE.test(msg) || /(?:做|生成|创建|来|写|整理|输出|produce|generate|create|make|write|build)/.test(msg);
  if (!hasGenVerb) {
    // "PPTX 和 PPT 有什么区别" already caught by NEGATIVE_RE.
    return { shouldOpenCard: false, reason: 'general' };
  }

  // Plain generation.
  return {
    shouldOpenCard: true,
    kind: resolveKind(),
    reason: 'generate_office',
    autoFill: {
      artifactType: resolveKind(),
      format: (msg.match(FORMAT_TOKEN_RE)?.[1]?.toLowerCase()) as any,
      contentOverview: extractContentOverview(msg),
      title: extractTitle(msg),
      audience: extractAudience(msg),
      pageOrSlideCount: parsePageCount(msg),
      documentType: extractDocumentType(msg),
      style: extractStyle(msg),
      sourceArtifactHint: false,
      operation: 'generate',
      targetRef: detectTargetRef(msg),
    },
  };
}

// ---------------- extractors ----------------

function parsePageCount(msg: string): number | undefined {
  if (DENSITY_RE.test(msg)) return undefined; // "简短" is NOT a page count
  const m = msg.match(PAGE_COUNT_RE);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 200) return n;
  }
  return undefined;
}

function extractContentOverview(msg: string): string {
  // "帮我做一份 10 页的 AI 入门 PPT" → "AI 入门"
  const m = msg.match(GEN_VERB_RE);
  if (m && m[1]) {
    let s = m[1]
      .replace(/^\s*(?:一个|一份|一张|一部|个|份|张|部)\s*/, '')
      .replace(/\d{1,3}\s*(?:页|张|slide|slides?|page|pages?)/i, '')
      .replace(/\b(pptx?|docx?|xlsx?|pdf)\b/gi, '')
      .replace(/(?:面向|给|for)\s*(?:.{1,20})?(?:的)?\s*$/i, '')
      .trim();
    s = s.replace(/^[，,。！!？?\s]+/, '');
    if (s.length >= 2) return s.slice(0, 80);
  }
  return msg.slice(0, 80);
}

function extractTitle(msg: string): string {
  const m = msg.match(/(?:做|生成|创建|写|来)\s*(?:一个|一份|个|份)?\s*([一-龥A-Za-z0-9]{2,30}?)(?:的|，|,|$)/i);
  if (m && m[1]) return m[1].trim();
  return '';
}

function extractAudience(msg: string): string {
  const m = msg.match(/(?:面向|给|针对)\s*(.{1,30}?)(?:的|，|,|$)/i);
  if (m && m[1]) return m[1].trim();
  return '';
}

function extractStyle(msg: string): string {
  const cues: string[] = [];
  if (/专业|professional/.test(msg)) cues.push('专业');
  if (/技术|technical/.test(msg)) cues.push('技术型');
  if (/简洁|concise/.test(msg)) cues.push('简洁');
  if (/轻松|casual|活泼/.test(msg)) cues.push('轻松');
  if (/正式|formal/.test(msg)) cues.push('正式');
  return cues.join('、');
}

function extractDocumentType(msg: string): string {
  if (/prd|产品需求|需求文档/i.test(msg)) return 'prd';
  if (/report|报告|总结/i.test(msg)) return 'report';
  if (/meeting|会议|纪要/i.test(msg)) return 'meeting-notes';
  if (/manual|说明书|手册/i.test(msg)) return 'manual';
  return '';
}

function detectTargetRef(msg: string): OfficeGateResult['autoFill'] extends infer T ? T extends { targetRef?: infer R } ? R : never : never {
  const pg = msg.match(TARGET_PAGE_RE);
  if (pg) return { type: 'page', index: parseInt(pg[1], 10) };
  const sh = msg.match(TARGET_SHEET_RE);
  if (sh) return { type: 'sheet', name: sh[2] ? sh[2] : undefined, index: sh[1] !== undefined && /^\d+$/.test(sh[1]) ? parseInt(sh[1], 10) : undefined };
  const se = msg.match(TARGET_SECTION_RE);
  if (se) return { type: 'section', index: parseInt(se[1], 10) };
  return undefined;
}

export function isPureOfficeDiscussion(msg: string): boolean {
  return NEGATIVE_RE.test(msg);
}
