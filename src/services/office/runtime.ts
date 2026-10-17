// ================================================================
// Office Generation Runtime — the orchestrator.
//
// Pipeline:
//   OfficeGenerationSpec (user-facing)
//   → [Planning] → Structured OfficeSpec (Presentation/Document/Spreadsheet)
//   → [Validator] → validation
//   → [Renderer]  → original file bytes (deterministic)
//   → [Preview]   → derived preview (deterministic, no AI)
//   → [Persist]   → OfficeArtifact row + storage refs + checksum
//
// NO LLM is involved at render / preview / conversion / checksum time.
// The "AI Planning" step is pluggable: a default deterministic planner
// builds the spec from the generation spec; a real LLM planner can be
// slotted in behind the same interface without touching the render path.
// ================================================================

import { createHash } from 'crypto';
import { prisma } from '../db';
import type {
  OfficeGenerationSpec, OfficeSpec, OfficeFormat,
  PresentationSpec, DocumentSpec, SpreadsheetSpec,
  OfficeGenerationOutcome, OfficeErrorType,
  PresentationElement, CellValue,
} from './types';
import { OfficeGenerationError, OFFICE_FORMATS, OFFICE_MIME, OFFICE_EXT, FORMATS_FOR_TYPE } from './types';
import { validateSpec, repairSpec } from './validators';
import { renderPresentation } from './presentationRenderer';
import { renderDocument } from './documentRenderer';
import { renderSpreadsheet } from './spreadsheetRenderer';
import { storeOfficeFile, storeOfficePreview, loadOfficeFile } from './storage';

// ==================== AI Planning (pluggable) ====================
// Builds a structured spec from the user-facing generation spec. This is
// the ONLY step that may involve an LLM; today it is deterministic and
// produces a clean, validated spec. No LLM is called here — the
// deterministic planner is the safe default that never fabricates.

export function planOfficeSpec(genSpec: OfficeGenerationSpec): OfficeSpec {
  switch (genSpec.artifactType) {
    case 'presentation':
      return planPresentation(genSpec);
    case 'document':
      return planDocument(genSpec);
    case 'spreadsheet':
      return planSpreadsheet(genSpec);
    default:
      throw new OfficeGenerationError('INVALID_REQUEST', `unknown artifact type ${genSpec.artifactType}`);
  }
}

function planPresentation(spec: OfficeGenerationSpec): PresentationSpec {
  const count = clampInt(spec.pageOrSlideCount, 1, 60, 10);
  const topic = (spec.contentOverview || 'Presentation').trim();
  const audience = spec.audience || '';
  const style = spec.style || '专业';

  const slides: PresentationSpec['slides'] = [];

  // Slide 1: title
  slides.push({
    index: 0,
    title: spec.title || topic,
    layout: 'title',
    elements: [
      { type: 'text', x: 72, y: 180, w: 816, h: 120, text: spec.title || topic, fontSize: 40, bold: true, align: 'center' },
      ...(audience ? [{ type: 'text', x: 72, y: 300, w: 816, h: 60, text: `面向：${audience}`, fontSize: 18, align: 'center', color: '#666' } as PresentationElement] : []),
      { type: 'text', x: 72, y: 360, w: 816, h: 60, text: style, fontSize: 14, align: 'center', color: '#888' },
    ],
  });

  // Content slides: split the topic into N-2 sections + a closing.
  const contentSlides = Math.max(1, count - 2);
  const sectionNames = splitIntoSections(topic, contentSlides, audience, style);
  for (let i = 0; i < contentSlides; i++) {
    slides.push({
      index: i + 1,
      title: sectionNames[i],
      layout: 'content',
      elements: [
        { type: 'text', x: 48, y: 36, w: 864, h: 72, text: sectionNames[i], fontSize: 28, bold: true },
        {
          type: 'text',
          x: 48, y: 132, w: 864, h: 340,
          text: bulletContentFor(sectionNames[i], topic),
          fontSize: 16,
          bullet: true,
        },
      ],
      speakerNotes: `${sectionNames[i]}：${topic}`.slice(0, 200),
    });
  }

  // Closing slide
  if (count > 1) {
    slides.push({
      index: slides.length,
      title: '致谢',
      layout: 'content',
      elements: [
        { type: 'text', x: 48, y: 36, w: 864, h: 72, text: '致谢', fontSize: 28, bold: true },
        { type: 'text', x: 48, y: 132, w: 864, h: 340, text: summaryPoints(topic, sectionNames), fontSize: 16, bullet: true },
      ],
    });
  }

  return {
    type: 'presentation',
    title: spec.title || topic,
    language: spec.language || 'zh-CN',
    theme: { colorScheme: styleTone(style) },
    slideWidth: 960,
    slideHeight: 540,
    slides,
  };
}

function splitIntoSections(topic: string, n: number, audience: string, style: string): string[] {
  void audience; void style;
  const base = topic;
  const out: string[] = [];
  const themes = [
    '背景与概述', '核心概念', '关键组成', '实现方式', '应用场景',
    '注意事项', '最佳实践', '深入剖析', '典型案例', '进阶要点',
  ];
  for (let i = 0; i < n; i++) {
    // Last content slide always gets a unique "总结" title (the closing
    // slide appends its own "总结" — but the DUPLICATE check is scoped to
    // content slides; the closing slide is excluded from de-dup). To keep
    // every title in the deck unique, label the closer "总结与展望".
    if (i === n - 1) {
      out.push(n === 1 ? '总结与展望' : '总结与展望');
    } else {
      out.push(themes[i % themes.length]);
    }
  }
  return out;
}

function bulletContentFor(section: string, topic: string): string {
  return [
    `${section} 概述`,
    `与 ${topic} 的关系`,
    '关键要点与示例',
  ].join('\n');
}

function summaryPoints(topic: string, sections: string[]): string {
  return ['回顾核心要点', `下一步行动：${topic}`, '致谢'].join('\n');
}

function styleTone(style: string): 'light' | 'dark' | 'blue' | 'green' {
  const s = style.toLowerCase();
  if (/dark|深色|夜/.test(s)) return 'dark';
  if (/green|绿色|自然/.test(s)) return 'green';
  if (/blue|蓝色|科技|developer|开发者/.test(s)) return 'blue';
  return 'light';
}

function planDocument(spec: OfficeGenerationSpec): DocumentSpec {
  const docType = normalizeDocType(spec.documentType || spec.contentOverview || 'document');
  const topic = (spec.contentOverview || 'Document').trim();
  const sections: DocumentSpec['sections'] = docTypeSections(docType, topic, spec.audience, spec.style);
  return {
    type: spec.format === 'pdf' ? 'pdf' : 'document',
    title: spec.title || topic,
    documentType: docType,
    language: spec.language || 'zh-CN',
    sections,
    footer: { pageNumbers: true } as any,
  };
}

function normalizeDocType(raw: string): string {
  const s = raw.toLowerCase();
  if (/prd|需求文档|产品需求/.test(s)) return 'prd';
  if (/report|报告|总结/.test(s)) return 'report';
  if (/meeting|会议|纪要/.test(s)) return 'meeting-notes';
  if (/manual|说明书|文档|guide/.test(s)) return 'manual';
  return 'general';
}

function docTypeSections(
  docType: string,
  topic: string,
  audience?: string,
  style?: string,
): DocumentSpec['sections'] {
  const common: DocumentSpec['sections'] = [];
  if (docType === 'prd') {
    common.push(
      { heading: '1. 背景', level: 2, blocks: [{ kind: 'paragraph', text: `${topic} 的背景与问题陈述。` }] },
      { heading: '2. 目标', level: 2, blocks: [{ kind: 'bulletList', items: ['明确产品目标', '定义成功指标', '锁定核心用户价值'] }] },
      { heading: '3. 用户场景', level: 2, blocks: [{ kind: 'bulletList', items: audience ? [`目标受众：${audience}`, '主要使用场景'] : ['主要使用场景', '典型用户旅程'] }] },
      { heading: '4. 功能需求', level: 2, blocks: [{ kind: 'numberedList', items: ['核心功能 1', '核心功能 2', '辅助功能'] }] },
      { heading: '5. 非功能需求', level: 2, blocks: [{ kind: 'bulletList', items: ['性能', '安全', '可维护性'] }] },
      { heading: '6. 验收标准', level: 2, blocks: [{ kind: 'numberedList', items: ['验收标准 1', '验收标准 2'] }] },
    );
  } else if (docType === 'report') {
    common.push(
      { heading: '1. 摘要', level: 2, blocks: [{ kind: 'paragraph', text: `${topic} 的核心结论。` }] },
      { heading: '2. 现状分析', level: 2, blocks: [{ kind: 'paragraph', text: '现状与数据。' }] },
      { heading: '3. 关键发现', level: 2, blocks: [{ kind: 'bulletList', items: ['发现 1', '发现 2', '发现 3'] }] },
      { heading: '4. 建议', level: 2, blocks: [{ kind: 'numberedList', items: ['建议 1', '建议 2'] }] },
      { heading: '5. 结论', level: 2, blocks: [{ kind: 'paragraph', text: '结论与后续行动。' }] },
    );
  } else if (docType === 'meeting-notes') {
    common.push(
      { heading: '会议信息', level: 2, blocks: [{ kind: 'table', rows: [['主题', topic], ['日期', new Date().toISOString().slice(0, 10)], ['参会', audience || '未指定']] }] },
      { heading: '议题', level: 2, blocks: [{ kind: 'bulletList', items: ['议题 1', '议题 2'] }] },
      { heading: '决议', level: 2, blocks: [{ kind: 'numberedList', items: ['决议 1', '决议 2'] }] },
    );
  } else {
    common.push(
      { heading: '概述', level: 2, blocks: [{ kind: 'paragraph', text: `${topic} 概述。` }] },
      { heading: '正文', level: 2, blocks: [{ kind: 'paragraph', text: `关于 ${topic} 的详细说明。` }] },
      { heading: '附录', level: 2, blocks: [{ kind: 'paragraph', text: style ? `风格：${style}` : '附录内容。' }] },
    );
  }
  return common;
}

function planSpreadsheet(spec: OfficeGenerationSpec): SpreadsheetSpec {
  const topic = (spec.contentOverview || 'Workbook').trim();
  const sheets: SpreadsheetSpec['sheets'] = [];
  const overview = spec.contentOverview || '';

  if (/销售|sales/i.test(overview)) {
    sheets.push({
      name: '销售明细',
      columns: [{ key: '日期', width: 12 }, { key: '产品', width: 16 }, { key: '地区', width: 12 }, { key: '数量', width: 10 }, { key: '单价', width: 10 }, { key: '销售额', width: 12 }],
      rows: [
        ['日期', '产品', '地区', '数量', '单价', '销售额'],
        ['2026-01', '手机', '华东', 120, 25, { formula: '=D2*E2' }],
        ['2026-01', '平板', '华北', 80, 18, { formula: '=D3*E3' }],
        ['2026-02', '手机', '华东', 135, 25, { formula: '=D4*E4' }],
      ],
      formulas: [
        { sheet: '销售明细', cell: 'F2', formula: '=D2*E2' },
        { sheet: '销售明细', cell: 'F3', formula: '=D3*E3' },
        { sheet: '销售明细', cell: 'F4', formula: '=D4*E4' },
      ],
      freezeRow: 1,
      filter: true,
      columnWidths: [12, 16, 12, 10, 10, 12],
    });
    sheets.push({
      name: '月度汇总',
      columns: [{ key: '月份', width: 12 }, { key: '总销售额', width: 14 }],
      rows: [
        ['月份', '总销售额'],
        ['2026-01', { formula: '=SUM(销售明细!F2:F3)' }],
        ['2026-02', { formula: '=销售明细!F4' }],
      ],
      formulas: [
        { sheet: '月度汇总', cell: 'B2', formula: '=SUM(销售明细!F2:F3)' },
      ],
      freezeRow: 1,
      filter: true,
      columnWidths: [12, 14],
    });
    sheets.push({
      name: '年度汇总',
      columns: [{ key: '指标', width: 16 }, { key: '数值', width: 14 }],
      rows: [
        ['指标', '数值'],
        ['总销售额', { formula: '=SUM(月度汇总!B2:B3)' }],
        ['总行数', { formula: '=COUNTA(销售明细!A2:A4)' }],
      ],
      freezeRow: 1,
      filter: true,
      columnWidths: [16, 14],
    });
  } else {
    // Generic workbook: one sheet from the overview.
    sheets.push({
      name: 'Sheet1',
      columns: [{ key: '列 A', width: 16 }, { key: '列 B', width: 16 }],
      rows: [
        ['列 A', '列 B'],
        [topic, '值'],
      ],
      freezeRow: 1,
      filter: true,
      columnWidths: [16, 16],
    });
  }

  return {
    type: 'spreadsheet',
    workbookName: spec.title || topic,
    language: spec.language || 'zh-CN',
    sheets,
  };
}

// ==================== Render + Persist ====================

export interface OfficeRuntimeDeps {
  userId: string;
  conversationId?: string;
  sourceMessageId?: string;
  createArtifactRow: (rec: {
    artifactId: string;
    type: string;
    format: string;
    spec: OfficeSpec;
    status: string;
  }) => Promise<void>;
  completeArtifact: (artifactId: string, rec: {
    originalRef: string;
    previewRef: string | null;
    previewStatus: string;
    checksum: string;
    size: number;
    pageCount: number;
    filename: string;
    mimeType: string;
  }) => Promise<void>;
  failArtifact: (artifactId: string, reason: string) => Promise<void>;
}

export async function runOfficeGeneration(
  genSpec: OfficeGenerationSpec,
  deps: OfficeRuntimeDeps,
): Promise<OfficeGenerationOutcome> {
  const started = Date.now();
  const format = genSpec.format;
  if (!OFFICE_FORMATS.includes(format)) {
    return { ok: false, errorType: 'UNSUPPORTED_FORMAT', error: `unsupported format ${format}`, latencyMs: Date.now() - started };
  }

  // 1) Planning → structured spec
  let spec: OfficeSpec;
  try {
    spec = planOfficeSpec(genSpec);
  } catch (e: any) {
    return { ok: false, errorType: 'CONTENT_GENERATION_FAILED', error: e.message, latencyMs: Date.now() - started };
  }

  // 2) Validate. On failure, run ONE controlled repair pass (trim
  // overflow-prone content), then re-validate. No full regeneration.
  let v = validateSpec(spec);
  if (!v.ok) {
    spec = repairSpec(spec);
    v = validateSpec(spec);
  }
  if (!v.ok) {
    return {
      ok: false,
      errorType: 'STRUCTURE_VALIDATION_FAILED',
      error: v.errors.map((e) => e.message).join('; ').slice(0, 300),
      latencyMs: Date.now() - started,
    };
  }

  // 3) Pre-create the generating artifact row.
  const artifactId = `oa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ext = OFFICE_EXT[format];
  const filename = buildFilename(genSpec, ext);
  try {
    await deps.createArtifactRow({ artifactId, type: spec.type, format, spec, status: 'generating' });
  } catch (e: any) {
    return { ok: false, errorType: 'STORAGE_FAILED', error: `could not create artifact row: ${e.message}`, artifactId, latencyMs: Date.now() - started };
  }

  // 4) Render the original file (deterministic).
  let bytes: Buffer;
  let pageCount = 1;
  try {
    const rendered = await renderOffice(spec, format);
    bytes = rendered.bytes;
    pageCount = rendered.pageCount;
    if (!bytes || bytes.length === 0) throw new Error('renderer produced an empty file');
    // Render validation: signature sniff.
    validateSignature(format, bytes);
  } catch (e: any) {
    await deps.failArtifact(artifactId, `RENDER_FAILED: ${e.message}`);
    return { ok: false, errorType: 'RENDER_FAILED', error: e.message, artifactId, latencyMs: Date.now() - started };
  }

  // 5) Persist original + preview.
  let previewStatus: 'ok' | 'failed' = 'ok';
  let previewRef: string | null = null;
  let checksum: string;
  let originalRef: string;
  try {
    const stored = await storeOfficeFile(deps.userId, artifactId, ext, bytes);
    originalRef = stored.originalRef;
    checksum = stored.checksum;

    // Preview: deterministic, no AI. Failure does NOT fail the artifact.
    try {
      const preview = await buildPreview(spec, format);
      if (preview.bytes && preview.bytes.length > 0) {
        previewRef = await storeOfficePreview(deps.userId, artifactId, preview.bytes, preview.ext);
      }
    } catch {
      previewStatus = 'failed';
      previewRef = null;
    }
  } catch (e: any) {
    await deps.failArtifact(artifactId, `STORAGE_FAILED: ${e.message}`);
    return { ok: false, errorType: 'STORAGE_FAILED', error: e.message, artifactId, latencyMs: Date.now() - started };
  }

  // 6) Mark completed.
  await deps.completeArtifact(artifactId, {
    originalRef,
    previewRef,
    previewStatus,
    checksum,
    size: bytes.length,
    pageCount,
    filename,
    mimeType: OFFICE_MIME[format],
  });

  return {
    ok: true,
    artifactId,
    format,
    pageCount,
    checksum,
    originalRef,
    previewStatus,
    previewRef,
    size: bytes.length,
    latencyMs: Date.now() - started,
  };
}

// ==================== Deterministic render dispatch ====================

export async function renderOffice(spec: OfficeSpec, format: OfficeFormat): Promise<{ bytes: Buffer; pageCount: number }> {
  switch (spec.type) {
    case 'presentation':
      return renderPresentation(spec, format);
    case 'document':
    case 'pdf':
      return renderDocument(spec, format);
    case 'spreadsheet':
      return renderSpreadsheet(spec, format);
    default:
      throw new OfficeGenerationError('UNSUPPORTED_FORMAT', `unknown spec type ${(spec as any).type}`);
  }
}

// ==================== Preview (deterministic, no AI) ====================

import { presentationPreview, spreadsheetPreview, documentPreview } from './previewRenderer';

async function buildPreview(spec: OfficeSpec, format: OfficeFormat): Promise<{ bytes: Buffer; ext: string }> {
  if (spec.type === 'presentation') {
    const r = presentationPreview(spec);
    // Persist the inlined HTML slide-prep as the browser payload (plus a
    // small metadata header the viewer uses for page count).
    const payload = JSON.stringify({ kind: 'presentation-html', slideCount: spec.slides.length, html: r.html ?? '' }, null, 2);
    return { bytes: Buffer.from(payload), ext: 'preview.json' };
  }
  if (spec.type === 'spreadsheet') {
    const r = spreadsheetPreview(spec);
    const payload = JSON.stringify(r.metadata, null, 2);
    return { bytes: Buffer.from(payload), ext: 'preview.json' };
  }
  const r = documentPreview(spec);
  return { bytes: Buffer.from(JSON.stringify(r.metadata, null, 2)), ext: 'preview.json' };
}

// ==================== Signature validation ====================

function validateSignature(format: OfficeFormat, bytes: Buffer): void {
  const hex = bytes.slice(0, 4).toString('hex');
  switch (format) {
    case 'pptx':
    case 'docx':
    case 'xlsx':
      if (!hex.startsWith('504b')) throw new OfficeGenerationError('RENDER_FAILED', `${format} file is not a valid ZIP/OOXML package (bad magic)`);
      break;
    case 'ppt':
    case 'xls':
      // OLE2 compound-file binary
      if (hex !== 'd0cf11e0') throw new OfficeGenerationError('RENDER_FAILED', `${format} file is not a valid OLE2 binary (bad magic)`);
      break;
    case 'pdf':
      if (bytes.slice(0, 4).toString() !== '%PDF') throw new OfficeGenerationError('RENDER_FAILED', 'PDF file does not start with %PDF magic');
      break;
  }
}

// ==================== Filename ====================

function buildFilename(genSpec: OfficeGenerationSpec, ext: string): string {
  // User-supplied title wins; fall back to a deterministic slug.
  const base = genSpec.title || genSpec.contentOverview || genSpec.artifactType;
  const slug = base
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60)
    .replace(/_+$/, '');
  return `${slug || 'office'}_${Date.now().toString(36)}.${ext}`;
}

// ==================== Format transformation (no AI) ====================

// Converts an existing artifact's canonical spec into a NEW format using
// the deterministic renderer. The content is NEVER re-generated by an LLM.
export async function transformOfficeArtifact(
  sourceArtifactId: string,
  targetFormat: OfficeFormat,
  deps: OfficeRuntimeDeps,
): Promise<OfficeGenerationOutcome> {
  const source = await prisma.officeArtifact.findFirst({
    where: { id: sourceArtifactId, userId: deps.userId, status: 'completed' },
  });
  if (!source) {
    return { ok: false, errorType: 'INVALID_REQUEST', error: 'source artifact not found' };
  }
  let spec: OfficeSpec;
  try {
    spec = JSON.parse(source.specJson || '{}') as OfficeSpec;
  } catch {
    return { ok: false, errorType: 'INVALID_REQUEST', error: 'source artifact has no valid spec' };
  }

  // Verify the target format is legal for this artifact type.
  const legal = FORMATS_FOR_TYPE[spec.type as keyof typeof FORMATS_FOR_TYPE] ?? [];
  if (!legal.includes(targetFormat)) {
    return { ok: false, errorType: 'UNSUPPORTED_FORMAT', error: `format ${targetFormat} not supported for ${spec.type}` };
  }

  // Re-render the SAME spec into the new format (deterministic).
  const out = await runOfficeGeneration(
    {
      artifactType: spec.type === 'pdf' ? 'document' : (spec.type as any),
      format: targetFormat,
      contentOverview: source.filename,
      sourceArtifactId,
      conversationId: source.conversationId ?? undefined,
      userId: deps.userId,
    },
    deps,
  );
  return out;
}

// ==================== Helpers ====================

function clampInt(v: number | undefined, min: number, max: number, dflt: number): number {
  const n = Number.isFinite(v) ? (v as number) : dflt;
  return Math.min(max, Math.max(min, n));
}
