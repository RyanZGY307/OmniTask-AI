// ================================================================
// Preview Renderer — deterministic preview representations for
// Office artifacts. These are NEVER AI-generated and NEVER required
// for download. If a preview fails, the original still downloads.
//
//   PPTX/PPT  -> HTML slide-prep (per-slide DOM, inlined)
//   DOCX/PDF  -> PDF page count + first-page text (for browser)
//   XLSX/XLS  -> spreadsheet-viewer JSON model (sheets + cells)
//
// The preview bytes/ref are stored alongside the original.
// ================================================================

import type {
  PresentationSpec, DocumentSpec, SpreadsheetSpec, OfficeSpec,
} from './types';

export interface PreviewResult {
  status: 'ok' | 'failed';
  ref: string | null;
  metadata: Record<string, any>;
  error?: string;
  // Optional deterministic payload that the preview writer persists and
  // the browser renders. For presentations this is the inlined HTML
  // slide-prep; for spreadsheets / documents the metadata JSON model is
  // the payload itself (no extra field needed).
  html?: string;
}

// Deterministic HTML preview of a presentation — renders each slide as
// a styled card. Inlined CSS so it is self-contained and safe.
export function presentationPreview(spec: PresentationSpec): PreviewResult {
  try {
    const slides = spec.slides.map((slide, i) => {
      const elements = slide.elements.map((el) => {
        if (el.type === 'text') {
          return `<div class="el" style="position:absolute;left:${(el.x / 12700).toFixed(1)}px;top:${(el.y / 12700).toFixed(1)}px;width:${(el.w / 12700).toFixed(1)}px;">
            <div style="font-size:${el.fontSize ?? 18}px;font-weight:${el.bold ? 700 : 400};font-style:${el.italic ? 'italic' : 'normal'};color:${el.color || '#111'};">${escapeHtml(el.text || '')}</div>
          </div>`;
        }
        if (el.type === 'table' && el.rows) {
          return `<div class="el" style="position:absolute;left:${(el.x / 12700).toFixed(1)}px;top:${(el.y / 12700).toFixed(1)}px;width:${(el.w / 12700).toFixed(1)}px;">
            <table style="border-collapse:collapse;font-size:12px;">${el.rows.map((r) => `<tr>${r.map((c) => `<td style="border:1px solid #999;padding:3px 6px;">${escapeHtml(String(c))}</td>`).join('')}</tr>`).join('')}</table>
          </div>`;
        }
        if (el.type === 'shape') {
          return `<div class="el" style="position:absolute;left:${(el.x / 12700).toFixed(1)}px;top:${(el.y / 12700).toFixed(1)}px;width:${(el.w / 12700).toFixed(1)}px;height:${(el.h / 12700).toFixed(1)}px;border:2px solid ${el.color || '#3B82F6'};border-radius:${el.shapeKind === 'ellipse' ? '50%' : '0'};"></div>`;
        }
        if (el.type === 'image') {
          return `<div class="el" style="position:absolute;left:${(el.x / 12700).toFixed(1)}px;top:${(el.y / 12700).toFixed(1)}px;width:${(el.w / 12700).toFixed(1)}px;height:${(el.h / 12700).toFixed(1)}px;background:#e5e7eb;border:1px dashed #999;display:flex;align-items:center;justify-content:center;font-size:10px;color:#666;">image</div>`;
        }
        return '';
      }).join('');

      return `<div class="slide" style="position:relative;width:960px;height:540px;background:${spec.theme.colorScheme === 'dark' ? '#0F172A' : '#fff'};border:1px solid #d1d5db;overflow:hidden;">
        ${slide.title ? `<div style="padding:24px;font-size:32px;font-weight:700;color:#111;">${escapeHtml(slide.title)}</div>` : ''}
        ${elements}
      </div>`;
    }).join('\n');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(spec.title)}</title>
      <style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:24px;background:#f3f4f6;}
      .slide{margin:0 auto 24px;box-shadow:0 2px 12px rgba(0,0,0,.08);}</style>
      </head><body>${slides}</body></html>`;

    return {
      status: 'ok',
      ref: null, // populated by the runtime writer
      html,
      metadata: { kind: 'presentation-html', slideCount: spec.slides.length },
    };
  } catch (e: any) {
    return { status: 'failed', ref: null, metadata: {}, error: e?.message };
  }
}

// Deterministic viewer model for a spreadsheet (the primary preview).
export function spreadsheetPreview(spec: SpreadsheetSpec): PreviewResult {
  try {
    const viewer = {
      kind: 'spreadsheet-viewer',
      sheetCount: spec.sheets.length,
      sheetNames: spec.sheets.map((s) => s.name),
      sheets: spec.sheets.map((s) => ({
        name: s.name,
        columns: s.columns?.map((c) => ({ key: c.key, width: c.width })) ?? [],
        rows: s.rows,
        formulas: s.formulas ?? [],
        freezeRow: s.freezeRow ?? 0,
        filter: !!s.filter,
      })),
    };
    return {
      status: 'ok',
      ref: null,
      metadata: viewer,
    };
  } catch (e: any) {
    return { status: 'failed', ref: null, metadata: {}, error: e?.message };
  }
}

// Deterministic document preview — page count + structural outline.
export function documentPreview(spec: DocumentSpec): PreviewResult {
  try {
    const outline = spec.sections.map((s) => ({
      heading: s.heading,
      level: s.level,
      blocks: s.blocks.map((b) => b.kind),
    }));
    const pageCount = Math.max(1, spec.sections.length);
    return {
      status: 'ok',
      ref: null,
      metadata: {
        kind: 'document-outline',
        pageCount,
        sectionCount: spec.sections.length,
        outline,
        title: spec.title,
        documentType: spec.documentType,
      },
    };
  } catch (e: any) {
    return { status: 'failed', ref: null, metadata: {}, error: e?.message };
  }
}

export function previewForSpec(spec: OfficeSpec): PreviewResult {
  if (spec.type === 'presentation') return presentationPreview(spec);
  if (spec.type === 'spreadsheet') return spreadsheetPreview(spec);
  return documentPreview(spec as DocumentSpec);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
