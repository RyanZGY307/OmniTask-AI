// ================================================================
// Office Preview Runtime — deterministically builds the preview
// representation from a stored spec. This is the on-demand
// regeneration path used when a cached preview file has been
// cleaned up. It NEVER calls an LLM and NEVER re-renders the
// original file.
// ================================================================

import {
  PresentationSpec, DocumentSpec, SpreadsheetSpec,
} from './types';
import {
  presentationPreview, spreadsheetPreview, documentPreview,
  type PreviewResult,
} from './previewRenderer';

export type OfficePreview =
  | { kind: 'presentation-html' | 'spreadsheet-viewer' | 'document-outline'; [k: string]: any };

function toPreview(r: PreviewResult): OfficePreview {
  // For presentations the inlined HTML slide-prep IS the browser payload,
  // so it is carried through the `html` field alongside the metadata.
  const base: Record<string, any> = { ...(r as any), kind: (r.metadata as any).kind || 'document-outline' };
  if (r.html !== undefined) base.html = r.html;
  return base as OfficePreview;
}

export function buildPreviewForSpec(spec: any, _format: string): OfficePreview {
  if (!spec || !spec.type) return { kind: 'document-outline', title: 'Preview', sectionCount: 0 };
  switch (spec.type) {
    case 'presentation':
      return toPreview(presentationPreview(spec as PresentationSpec));
    case 'spreadsheet':
      return toPreview(spreadsheetPreview(spec as SpreadsheetSpec));
    case 'document':
    case 'pdf':
    default:
      return toPreview(documentPreview(spec as DocumentSpec));
  }
}
