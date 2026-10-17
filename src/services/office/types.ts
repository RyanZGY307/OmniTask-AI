// ================================================================
// Office / Document / Presentation / Spreadsheet — shared types.
//
// These specs are the CANONICAL structured source of truth. They are
// written to OfficeArtifact.specJson and are the input to every
// deterministic renderer + the format-conversion path. The LLM only
// ever produces a spec; it never produces the binary file.
//
// Artifact types:
//   presentation  -> PPTX | PPT
//   document      -> DOCX | PDF
//   spreadsheet   -> XLSX | XLS
//   pdf           -> PDF (document-derived or standalone)
// ================================================================

export type OfficeArtifactType = 'presentation' | 'document' | 'spreadsheet' | 'pdf';

export type OfficeFormat = 'pptx' | 'ppt' | 'docx' | 'pdf' | 'xlsx' | 'xls';

export const OFFICE_FORMATS: OfficeFormat[] = ['pptx', 'ppt', 'docx', 'pdf', 'xlsx', 'xls'];

export const OFFICE_MIME: Record<OfficeFormat, string> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
};

export const OFFICE_EXT: Record<OfficeFormat, string> = {
  pptx: 'pptx', ppt: 'ppt', docx: 'docx', pdf: 'pdf', xlsx: 'xlsx', xls: 'xls',
};

// Canonical source: which artifact types can be produced for a given
// format. Used by the format-transformation path so that e.g. a PPTX
// artifact can re-render to PPT/PDF, a DOCX artifact can re-render to
// PDF, and an XLSX artifact can re-render to XLS — all from the spec.
export const FORMATS_FOR_TYPE: Record<OfficeArtifactType, OfficeFormat[]> = {
  presentation: ['pptx', 'ppt', 'pdf'],
  document: ['docx', 'pdf'],
  spreadsheet: ['xlsx', 'xls'],
  pdf: ['pdf'],
};

// ================================================================
// PresentationSpec
// ================================================================

export type PresentationLayout =
  | 'title' | 'section' | 'content' | 'two_column' | 'image_focus' | 'chart' | 'table';

export type PresentationElementType = 'text' | 'image' | 'shape' | 'table' | 'chart';

export interface PresentationElement {
  type: PresentationElementType;
  // Frame in points (slide is 960x540pt widescreen by default).
  x: number;
  y: number;
  w: number;
  h: number;
  // text
  text?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right' | 'justify';
  color?: string; // hex or named
  bullet?: boolean;
  // image
  imageRef?: string; // storage ref or URL — never an inline base64 blob
  // shape
  shapeKind?: 'rect' | 'ellipse' | 'line';
  // table
  rows?: (string | number)[][];
  // chart
  chart?: {
    kind: 'bar' | 'line' | 'pie';
    labels: string[];
    series: { name: string; values: number[] }[];
  };
  // speaker notes
  notes?: string;
}

export interface PresentationSlide {
  index: number;
  title?: string;
  layout: PresentationLayout;
  elements: PresentationElement[];
  speakerNotes?: string;
}

export interface ThemeSpec {
  colorScheme: string; // 'light' | 'dark' | 'blue' | 'green'
  fontFace?: string;
}

export interface PresentationSpec {
  type: 'presentation';
  title: string;
  language: string;
  theme: ThemeSpec;
  slideWidth?: number; // pt, default 960
  slideHeight?: number; // pt, default 540
  slides: PresentationSlide[];
}

// ================================================================
// DocumentSpec (DOCX + PDF)
// ================================================================

export type DocumentBlockKind =
  | 'paragraph' | 'heading' | 'bulletList' | 'numberedList' | 'table' | 'image' | 'quote' | 'code' | 'pageBreak';

export interface DocumentBlock {
  kind: DocumentBlockKind;
  text?: string;
  level?: number; // heading level 1-6
  items?: string[]; // for lists
  rows?: (string | number)[][]; // for table
  imageRef?: string; // storage ref or URL
  language?: string; // for code
}

export interface DocumentSection {
  heading?: string;
  level?: number;
  blocks: DocumentBlock[];
}

export interface HeaderFooterSpec {
  left?: string;
  center?: string;
  right?: string;
  pageNumbers?: boolean;
}

export interface DocumentSpec {
  type: 'document' | 'pdf';
  title: string;
  documentType: string; // 'prd' | 'report' | 'meeting-notes' | 'manual' | 'general'
  language: string;
  sections: DocumentSection[];
  header?: HeaderFooterSpec;
  footer?: HeaderFooterSpec;
}

// ================================================================
// SpreadsheetSpec (XLSX + XLS)
// ================================================================

export type CellValue = string | number | boolean | null | { formula: string };

export interface ColumnSpec {
  key: string;
  width?: number; // in characters
}

export interface FormulaSpec {
  sheet: string;
  cell: string; // 'B2'
  formula: string; // '=D2*E2'
}

export interface SheetChart {
  kind: 'bar' | 'line' | 'pie' | 'area';
  title?: string;
  labels: string[];
  series: { name: string; values: number[] }[];
  from: number; // 1-based row of data
  to?: number;
}

export interface SheetSpec {
  name: string;
  columns?: ColumnSpec[];
  rows: CellValue[][];
  formulas?: FormulaSpec[];
  freezeRow?: number; // number of header rows to freeze
  filter?: boolean;
  charts?: SheetChart[];
  columnWidths?: number[];
}

export interface SpreadsheetSpec {
  type: 'spreadsheet';
  workbookName: string;
  language: string;
  sheets: SheetSpec[];
}

export type OfficeSpec =
  | PresentationSpec
  | DocumentSpec
  | SpreadsheetSpec;

// ================================================================
// Generation spec (user-facing, pre-Planning)
// ================================================================

export interface OfficeGenerationSpec {
  artifactType: 'presentation' | 'document' | 'spreadsheet';
  format: OfficeFormat;
  contentOverview: string;
  language?: string;
  title?: string;
  audience?: string;
  pageOrSlideCount?: number;
  documentType?: string;
  style?: string;
  sourceMessageId?: string;
  conversationId?: string;
  userId?: string;
  // Format transformation: existing artifact to convert from (no AI).
  sourceArtifactId?: string;
  // "Brief / dense" style cue — never parsed as a page count.
  density?: 'brief' | 'standard' | 'detailed';
}

// ================================================================
// Rendered artifact + outcome
// ================================================================

export type OfficeErrorType =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_FORMAT'
  | 'CONTENT_GENERATION_FAILED'
  | 'STRUCTURE_VALIDATION_FAILED'
  | 'RENDER_FAILED'
  | 'PREVIEW_FAILED'
  | 'STORAGE_FAILED'
  | 'CONVERSION_FAILED';

export class OfficeGenerationError extends Error {
  readonly errorType: OfficeErrorType;
  constructor(errorType: OfficeErrorType, message: string) {
    super(message);
    this.name = 'OfficeGenerationError';
    this.errorType = errorType;
  }
}

export interface OfficeGenerationOutcome {
  ok: boolean;
  errorType?: OfficeErrorType;
  error?: string;
  artifactId?: string;
  format?: OfficeFormat;
  pageCount?: number;
  checksum?: string;
  originalRef?: string;
  previewStatus?: 'ok' | 'failed';
  previewRef?: string | null;
  size?: number;
  latencyMs?: number;
}
