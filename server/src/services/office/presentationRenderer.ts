// ================================================================
// Presentation Renderer — PresentationSpec → PPTX / PPT.
//
// Deterministic: no LLM. The spec is the ONLY input.
//   PPTX  -> pptxgenjs (OOXML zip)
//   PPT   -> ppt-codec (MS-PPT binary, [MS-PPT])
//
// Both are valid, openable Office files — no fake extension renames.
// ================================================================

import PptxGenJS from 'pptxgenjs';
// ppt-codec is a CJS export; require it through the ESM interop.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PptCodec: any = require('ppt-codec');
import type {
  PresentationSpec,
  PresentationElement,
  OfficeFormat,
} from './types';

export interface RenderedFile {
  bytes: Buffer;
  format: OfficeFormat;
  pageCount: number;
}

const EMU_PER_PT = 12700;

// ---------------- PPTX ----------------

function addPptxElement(s: any, el: PresentationElement, theme: any): void {
  // pptxgenjs coordinates are in inches (layout width/height are inches).
  const x = el.x / 72;
  const y = el.y / 72;
  const w = el.w / 72;
  const h = el.h / 72;

  switch (el.type) {
    case 'text':
      s.addText(el.text || '', {
        x, y, w, h,
        fontSize: el.fontSize ?? 18,
        bold: !!el.bold,
        italic: !!el.italic,
        align: el.align === 'center' ? 'center' : el.align === 'right' ? 'right' : 'left',
        color: el.color || (theme.colorScheme === 'dark' ? 'FFFFFF' : '1F2937'),
        bullet: el.bullet ? { code: '25CF', indent: 14 } : undefined,
      });
      break;
    case 'image':
      if (el.imageRef) s.addImage({ path: el.imageRef, x, y, w, h });
      break;
    case 'shape':
      s.addShape((el.shapeKind === 'ellipse' ? 'ellipse' : el.shapeKind === 'line' ? 'line' : 'rect') as any, {
        x, y, w, h,
        line: { color: el.color || '3B82F6', width: 2 },
      });
      break;
    case 'table':
      if (el.rows) {
        s.addTable(el.rows.map((row) => row.map((c) => ({ text: String(c) }))), {
          x, y, w, h, fontSize: 12,
        });
      }
      break;
    case 'chart':
      if (el.chart) {
        s.addChart(
          el.chart.kind as any,
          el.chart.series.map((ser) => ({
            name: ser.name,
            labels: el.chart!.labels,
            values: ser.values,
          })),
          { x, y, w, h, showLegend: el.chart.kind === 'pie' },
        );
      }
      break;
  }
}

function themeBackground(spec: PresentationSpec): string {
  const m: Record<string, string> = {
    light: 'FFFFFF', dark: '0F172A', blue: 'EFF6FF', green: 'F0FDF4',
  };
  return m[spec.theme.colorScheme] || 'FFFFFF';
}

// PptxGenJS async write helper (returns nodebuffer).
export async function writePptx(spec: PresentationSpec): Promise<Buffer> {
  const pptx: any = new PptxGenJS();
  const w = spec.slideWidth ?? 960;
  const h = spec.slideHeight ?? 540;
  pptx.defineLayout({ name: 'CORTX', width: w / 96, height: h / 96 });
  pptx.layout = 'CORTX';
  pptx.title = spec.title;
  pptx.author = 'OmniTask';

  spec.slides.forEach((slide) => {
    const s = pptx.addSlide();
    s.background = { color: themeBackground(spec) };
    for (const el of slide.elements) addPptxElement(s, el, spec.theme);
    if (slide.speakerNotes) s.addNotes(slide.speakerNotes);
  });

  const buf: Buffer = await pptx.write({ outputType: 'nodebuffer' });
  return buf;
}

// ---------------- PPT (legacy binary, [MS-PPT]) ----------------

// Maps a PresentationSpec into the ppt-codec "content" shape that
// writePptContent accepts: slides[].shapes[].blocks[]. Coordinates are
// in points.
export function renderPresentationPpt(spec: PresentationSpec): RenderedFile {
  const w = spec.slideWidth ?? 960;
  const h = spec.slideHeight ?? 540;
  const pt = (emu: number) => Math.round(emu / EMU_PER_PT);

  const slides = spec.slides.map((slide, i) => ({
    name: slide.title || `Slide ${i + 1}`,
    size: { widthPt: w, heightPt: h },
    notes: [],
    shapes: slide.elements
      .filter((el) => el.type === 'text' || el.type === 'table')
      .map((el) => {
        if (el.type === 'table' && el.rows) {
          // Tables render as stacked text rows in legacy PPT (no native table).
          return {
            kind: 'text',
            frame: { xPt: pt(el.x), yPt: pt(el.y), widthPt: pt(el.w), heightPt: pt(el.h) },
            blocks: el.rows
              .flatMap((row) => [row.map(String)])
              .map((line) => ({
                kind: 'textBlock',
                text: line.join(' | '),
                font: { sizePt: el.fontSize ?? 14 },
              })),
          };
        }
        return {
          kind: 'text',
          frame: { xPt: pt(el.x), yPt: pt(el.y), widthPt: pt(el.w), heightPt: pt(el.h) },
          blocks: [{
            kind: 'textBlock',
            text: el.text || '',
            font: {
              sizePt: el.fontSize ?? 18,
              bold: !!el.bold,
              italic: !!el.italic,
            },
            align: el.align,
          }],
        };
      }),
  }));

  const content = {
    metadata: {
      title: spec.title,
      author: 'OmniTask',
      subject: '',
      company: '',
      lastPrinted: 0,
      revision: 1,
    },
    slides,
  };

  const bytes = Buffer.from(PptCodec.writePptContent(content));
  return { bytes, format: 'ppt', pageCount: spec.slides.length };
}

// ---------------- Unified entry ----------------

export async function renderPresentation(spec: PresentationSpec, format: OfficeFormat): Promise<RenderedFile> {
  if (format === 'pptx') {
    const bytes = await writePptx(spec);
    return { bytes, format: 'pptx', pageCount: spec.slides.length };
  }
  // Legacy PPT — deterministic binary via ppt-codec.
  const out = renderPresentationPpt(spec);
  return out;
}
