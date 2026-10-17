// ================================================================
// Office Validators — deterministic structure checks on a spec
// BEFORE rendering. A validation failure is an explicit
// STRUCTURE_VALIDATION_FAILED (never a fake completed).
//
// For AI content we allow ONE controlled correction pass; the rest
// of the error surface is reported to the user, not auto-retried.
// ================================================================

import type {
  OfficeSpec, PresentationSpec, PresentationElement,
  DocumentSpec, SpreadsheetSpec,
} from './types';

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
}

export interface ValidationIssue {
  code:
    | 'ELEMENT_OVERFLOW' | 'MISSING_TITLE' | 'EMPTY_SLIDE' | 'INVALID_DIMENSIONS'
    | 'IMAGE_MISSING' | 'CHART_DATA_INVALID' | 'DUPLICATE_TITLE' | 'UNSUPPORTED_ELEMENT'
    | 'EMPTY_SECTION' | 'MISSING_TABLE_STRUCTURE' | 'INVALID_CELL_TYPE'
    | 'BROKEN_REFERENCE' | 'FORMULA_INVALID' | 'SHEET_NAME_COLLISION'
    | 'UNKNOWN';
  message: string;
  path?: string;
}

const SLIDE_W_PT = 960;
const SLIDE_H_PT = 540;

export function validateSpec(spec: OfficeSpec): ValidationResult {
  switch (spec.type) {
    case 'presentation':
      return validatePresentation(spec);
    case 'document':
    case 'pdf':
      return validateDocument(spec);
    case 'spreadsheet':
      return validateSpreadsheet(spec);
    default:
      return { ok: false, errors: [{ code: 'UNKNOWN', message: 'unknown spec type' }] };
  }
}

// ---------------- Presentation ----------------

function validatePresentation(spec: PresentationSpec): ValidationResult {
  const errors: ValidationIssue[] = [];
  const seenTitles = new Set<string>();

  spec.slides.forEach((slide) => {
    const titleKey = (slide.title || '').trim().toLowerCase();
    if (titleKey && seenTitles.has(titleKey)) {
      errors.push({
        code: 'DUPLICATE_TITLE',
        message: `Duplicate slide title "${slide.title}"`,
        path: `slides[${slide.index}]`,
      });
    }
    if (titleKey) seenTitles.add(titleKey);

    if (slide.layout !== 'title' && !slide.title && slide.elements.length === 0) {
      errors.push({
        code: 'EMPTY_SLIDE',
        message: `Slide ${slide.index + 1} is empty`,
        path: `slides[${slide.index}]`,
      });
    }

    slide.elements.forEach((el, i) => {
      const p = `slides[${slide.index}].elements[${i}]`;
      if (el.type === 'image' && !el.imageRef) {
        errors.push({ code: 'IMAGE_MISSING', message: 'image element has no ref', path: p });
      }
      if (el.x < 0 || el.y < 0 || el.w <= 0 || el.h <= 0) {
        errors.push({ code: 'INVALID_DIMENSIONS', message: 'non-positive or negative element frame', path: p });
        return;
      }
      // Overflow check: element frames must stay inside the slide bounds.
      // Our spec stores coordinates in points (960x540 slide).
      const slideW = spec.slideWidth ?? 960;
      const slideH = spec.slideHeight ?? 540;
      if (el.x + el.w > slideW + 1 || el.y + el.h > slideH + 1) {
        errors.push({
          code: 'ELEMENT_OVERFLOW',
          message: `element overflows slide bounds (${el.x}+${el.w} > ${slideW})`,
          path: p,
        });
      }
      if (el.type === 'chart' && el.chart) {
        if (el.chart.labels.length === 0 || el.chart.series.length === 0) {
          errors.push({ code: 'CHART_DATA_INVALID', message: 'chart missing labels or series', path: p });
        }
        if (el.chart.series.some((s) => s.values.some((v) => typeof v !== 'number' || Number.isNaN(v)))) {
          errors.push({ code: 'CHART_DATA_INVALID', message: 'chart series contains non-numeric values', path: p });
        }
      }
      if (el.type === 'table' && el.rows) {
        const rows = el.rows;
        if (rows.length > 0) {
          const cols = rows[0].length;
          if (rows.some((r) => r.length !== cols)) {
            errors.push({ code: 'MISSING_TABLE_STRUCTURE', message: 'table rows have uneven column counts', path: p });
          }
        }
      }
      const supported: Array<PresentationElement['type']> = ['text', 'image', 'shape', 'table', 'chart'];
      if (!supported.includes(el.type)) {
        errors.push({ code: 'UNSUPPORTED_ELEMENT', message: `unsupported element type "${el.type}"`, path: p });
      }
    });
  });

  // Global: at least one slide
  if (spec.slides.length === 0) {
    errors.push({ code: 'EMPTY_SLIDE', message: 'presentation has no slides' });
  }

  return { ok: errors.length === 0, errors };
}

// ---------------- Document ----------------

function validateDocument(spec: DocumentSpec): ValidationResult {
  const errors: ValidationIssue[] = [];
  spec.sections.forEach((section, i) => {
    const p = `sections[${i}]`;
    if (section.blocks.length === 0) {
      errors.push({ code: 'EMPTY_SECTION', message: `section ${i + 1} (${section.heading || 'untitled'}) has no blocks`, path: p });
    }
    section.blocks.forEach((b, j) => {
      if (b.kind === 'table' && b.rows && b.rows.length > 0) {
        const cols = b.rows[0].length;
        if (b.rows.some((r) => r.length !== cols)) {
          errors.push({ code: 'MISSING_TABLE_STRUCTURE', message: 'table block has uneven rows', path: `${p}.blocks[${j}]` });
        }
      }
      if (b.kind === 'image' && !b.imageRef) {
        errors.push({ code: 'IMAGE_MISSING', message: 'image block has no ref', path: `${p}.blocks[${j}]` });
      }
      // Heading hierarchy: a level-N heading may not be skipped more than one level up.
      if (b.kind === 'heading' && b.level && i > 0) {
        const prevLevels = spec.sections.slice(0, i).flatMap((s) => s.blocks).filter((x) => x.kind === 'heading').map((x) => x.level ?? 3);
        if (prevLevels.length > 0) {
          const prevMax = Math.max(...prevLevels);
          if (b.level > prevMax + 1) {
            errors.push({ code: 'UNKNOWN', message: `heading level ${b.level} skips a level (prev max ${prevMax})`, path: `${p}.blocks[${j}]` });
          }
        }
      }
    });
  });
  if (spec.sections.length === 0) {
    errors.push({ code: 'EMPTY_SECTION', message: 'document has no sections' });
  }
  return { ok: errors.length === 0, errors };
}

// ---------------- Spreadsheet ----------------

function validateSpreadsheet(spec: SpreadsheetSpec): ValidationResult {
  const errors: ValidationIssue[] = [];
  const names = new Set<string>();
  spec.sheets.forEach((sheet, i) => {
    const p = `sheets[${i}]`;
    if (names.has(sheet.name.toLowerCase())) {
      errors.push({ code: 'SHEET_NAME_COLLISION', message: `sheet name "${sheet.name}" collides`, path: p });
    }
    names.add(sheet.name.toLowerCase());

    (sheet.rows || []).forEach((row, r) => {
      row.forEach((cell, c) => {
        if (cell && typeof cell === 'object' && 'formula' in cell) {
          const f = (cell as any).formula;
          if (typeof f !== 'string' || !f.startsWith('=')) {
            errors.push({ code: 'FORMULA_INVALID', message: `formula cell not a "=..." string`, path: `${p}.rows[${r}][${c}]` });
          }
          // Broken-reference heuristic: a formula that references a
          // sheet not present in this workbook.
          const ref = f.match(/'([^']+)'!|([A-Z]+\d+)/);
          if (ref && ref[1] && !spec.sheets.some((s) => s.name === ref[1])) {
            errors.push({ code: 'BROKEN_REFERENCE', message: `formula references unknown sheet "${ref[1]}"`, path: `${p}.rows[${r}][${c}]` });
          }
        } else if (cell !== null && cell !== undefined && !['string', 'number', 'boolean'].includes(typeof cell)) {
          errors.push({ code: 'INVALID_CELL_TYPE', message: 'unsupported cell value type', path: `${p}.rows[${r}][${c}]` });
        }
      });
    });

    if ((sheet.charts || []).some((ch) => ch.series.some((s) => s.values.some((x) => typeof x !== 'number')))) {
      errors.push({ code: 'FORMULA_INVALID', message: 'chart series contains non-numeric values', path: p });
    }
  });

  if (spec.sheets.length === 0) {
    errors.push({ code: 'EMPTY_SECTION', message: 'workbook has no sheets' });
  }
  return { ok: errors.length === 0, errors };
}

// One controlled correction pass: drop empty / overflow-prone slides
// that are clearly AI bloat ("this page has too much content"), and
// de-duplicate slide titles so the structure validates cleanly.
export function repairSpec(spec: OfficeSpec): OfficeSpec {
  if (spec.type !== 'presentation') return spec;
  const seen = new Set<string>();
  const repaired: PresentationSpec = {
    ...spec,
    slides: spec.slides.map((s, idx) => {
      // De-dup titles: keep the first, suffix later repeats.
      let base = (s.title || '').trim().toLowerCase();
      let title = s.title || '';
      if (base && seen.has(base)) {
        let k = 2;
        while (seen.has(`${base} (${k})`)) k++;
        title = `${s.title || `Slide ${idx + 1}`} (${k - 1})`.trim();
        base = title.toLowerCase();
      }
      if (base) seen.add(base);
      return {
        ...s,
        title: title || s.title,
        // Trim text elements that overflow their frame (approx):
        elements: s.elements.map((el) =>
          el.type === 'text' && el.text && el.text.length > 400
            ? { ...el, text: el.text.slice(0, 400) + '…' }
            : el,
        ),
      };
    }),
  };
  return repaired;
}
