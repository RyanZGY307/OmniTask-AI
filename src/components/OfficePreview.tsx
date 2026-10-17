'use client';
import { getApiUrl } from '@/lib/api';
import { useEffect, useMemo, useState } from 'react';
import { OFFICE_FORMAT_LABELS, type OfficeFormat } from '@/lib/models';

// =====================================================================
// Office Preview — in-chat viewer for a completed office artifact.
//
// Data source of truth is the SERVER: the preview representation is
// fetched from /api/chat/office/:messageId/preview (a derived,
// regenerable JSON / HTML payload — never the original binary, and
// never AI-generated). Download always pulls the ORIGINAL file via
// /api/chat/office/:messageId/download. Survives refresh.
//
// Per-artifact-type presentation:
//   presentation -> slide thumbnail strip + page nav
//   document     -> page nav + zoom
//   spreadsheet  -> sheet tabs + cell grid
//
// Reuses the shared Liquid Glass spec-card system (no new glass tokens).
// =====================================================================

interface Props {
  messageId: string;
  type?: string;
  format?: string;
  filename?: string;
  size?: number;
  pageCount?: number;
}

type PreviewKind =
  | { kind: 'presentation-html'; slideCount?: number }
  | { kind: 'spreadsheet-viewer'; sheetNames?: string[]; sheets?: any[] }
  | { kind: 'document-outline'; pageCount?: number; sectionCount?: number; outline?: any[]; title?: string };

export default function OfficePreview({ messageId, type, format, filename, size, pageCount }: Props) {
  const base = getApiUrl();
  const token = typeof window !== 'undefined' ? localStorage.getItem('cortex_token') : null;
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const downloadHref = `${base}/chat/office/${messageId}/download`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${base}/chat/office/${messageId}/preview`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) {
          if (!cancelled) setError('预览不可用，请下载原始文件');
          return;
        }
        const text = await res.text();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = { kind: 'presentation-html', html: text }; }
        if (!cancelled) setPreview(parsed);
      } catch {
        if (!cancelled) setError('预览不可用，请下载原始文件');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [messageId, base, token]);

  const fmt = format as OfficeFormat | undefined;
  const kindLabel = type
    ? ({ presentation: '演示文稿', document: '文档', spreadsheet: '表格' } as Record<string, string>)[type]
    : undefined;

  return (
    <div className="liquid-glass rounded-card p-3 space-y-2 max-w-md">
      <div className="text-xs text-muted flex items-center gap-1.5 flex-wrap">
        <span>📄</span>
        {kindLabel ? <span>{kindLabel}</span> : <span>办公文档</span>}
        {fmt ? (
          <span className="text-[10px] text-muted/70">{OFFICE_FORMAT_LABELS[fmt] || fmt}</span>
        ) : null}
        {pageCount ? <span className="text-[10px] text-muted/70">· {pageCount} 页</span> : null}
        {size ? <span className="text-[10px] text-muted/70">· {(size / 1024).toFixed(1)} KB</span> : null}
      </div>

      {error ? (
        <div className="text-xs text-error flex items-center gap-1.5">
          <span>⚠</span> {error}
        </div>
      ) : !loaded ? (
        <div className="text-xs text-muted">加载预览中…</div>
      ) : preview ? (
        <PreviewBody preview={preview} type={type} />
      ) : null}

      <div className="flex items-center justify-between gap-2 pt-1">
        <a
          href={downloadHref}
          target="_blank"
          rel="noreferrer"
          download={filename}
          className="text-xs text-accent hover:text-accent/80 transition-colors"
        >
          下载原始文件
        </a>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Per-type preview body
// ------------------------------------------------------------------

function PreviewBody({ preview, type }: { preview: any; type?: string }) {
  // Presentation: HTML slide-prep.
  if (preview?.kind === 'presentation-html') {
    return <PresentationPreview html={preview.html} slideCount={preview.slideCount} />;
  }
  // Spreadsheet: viewer JSON model.
  if (preview?.kind === 'spreadsheet-viewer') {
    return <SpreadsheetPreview model={preview} />;
  }
  // Document: outline JSON.
  if (preview?.kind === 'document-outline') {
    return <DocumentPreview model={preview} />;
  }
  // Unknown payload: show what we have.
  return (
    <pre className="text-[11px] text-muted overflow-auto max-h-40 whitespace-pre-wrap">
      {JSON.stringify(preview, null, 2)}
    </pre>
  );
}

function PresentationPreview({ html, slideCount }: { html?: string; slideCount?: number }) {
  const [idx, setIdx] = useState(0);
  const count = Math.max(1, slideCount ?? 1);
  const [zoom, setZoom] = useState(0.5);

  if (!html) {
    return (
      <div className="text-xs text-muted">
        预览：演示文稿 {count} 页
        <PageNav count={count} idx={idx} setIdx={setIdx} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        className="overflow-auto max-h-72 rounded-card border border-line bg-surface"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div className="flex items-center justify-between gap-2">
        <PageNav count={count} idx={idx} setIdx={setIdx} />
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setZoom((z) => Math.max(0.25, z - 0.1))}
            className="px-2 py-0.5 text-[11px] text-muted rounded-capsule border border-line hover:text-primary transition-colors"
          >
            −
          </button>
          <span className="text-[10px] text-muted w-8 text-center">{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => setZoom((z) => Math.min(1.5, z + 0.1))}
            className="px-2 py-0.5 text-[11px] text-muted rounded-capsule border border-line hover:text-primary transition-colors"
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}

function SpreadsheetPreview({ model }: { model: any }) {
  const [active, setActive] = useState(0);
  const sheets: any[] = model.sheets ?? [];
  const sheet = sheets[active];
  const [q, setQ] = useState('');

  if (!sheet) {
    return <div className="text-xs text-muted">预览：表格 {sheets.length} 个工作表</div>;
  }

  const columns: any[] = sheet.columns?.length
    ? sheet.columns
    : (sheet.rows?.[0] ?? []).map((c: any, i: number) => ({ key: String(c ?? i), width: 12 }));

  let rows: any[][] = sheet.rows ?? [];
  if (q.trim()) {
    rows = rows.filter((r) => r.some((cell) => String(cell ?? '').toLowerCase().includes(q.trim().toLowerCase())));
  }

  return (
    <div className="space-y-2">
      {sheets.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => { setActive(i); setQ(''); }}
              className={`px-2.5 py-1 rounded-capsule text-[11px] transition-all ${i === active ? 'bg-accent/15 text-accent border border-accent/30' : 'text-muted border border-transparent hover:text-primary'}`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="过滤单元格内容…"
        className="w-full bg-surface border border-line rounded-card px-3 py-1.5 text-xs text-primary placeholder:text-muted/50 focus:outline-none focus:border-accent/50 transition-colors"
      />
      <div className="overflow-auto max-h-72 rounded-card border border-line">
        <table className="text-[11px] w-full border-collapse">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th
                  key={i}
                  className="sticky top-0 bg-surface text-left px-2 py-1.5 border-b border-line text-muted font-medium whitespace-nowrap"
                  style={{ minWidth: (c.width ?? 12) * 8 }}
                >
                  {c.key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={columns.length || 1} className="px-2 py-3 text-center text-muted">无匹配行</td></tr>
            ) : (
              rows.map((r, ri) => (
                <tr key={ri} className="hover:bg-surface-hover/50">
                  {columns.map((c, ci) => {
                    const raw = r[ci];
                    const isFormula = typeof raw === 'object' && raw && 'formula' in raw;
                    return (
                      <td key={ci} className="px-2 py-1 border-b border-line/50 whitespace-nowrap">
                        {isFormula ? (
                          <span className="text-warning" title={String((raw as any).formula)}>
                            {String((raw as any).formula)}
                          </span>
                        ) : (
                          String(raw ?? '')
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DocumentPreview({ model }: { model: any }) {
  const outline: any[] = model.outline ?? [];
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, model.pageCount ?? outline.length ?? 1);

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted">
        {model.title ? `${model.title} · ` : ''}
        {model.sectionCount ?? outline.length} 节 / {pageCount} 页
      </div>
      <div className="overflow-auto max-h-60 rounded-card border border-line bg-surface p-3">
        {outline.length === 0 ? (
          <div className="text-xs text-muted">文档大纲</div>
        ) : (
          <ul className="space-y-1.5">
            {outline.map((s, i) => (
              <li key={i} style={{ paddingLeft: `${(s.level ?? 1) * 12}px` }} className="text-xs text-primary">
                <span className="text-muted/60 mr-1.5">{i + 1}.</span>
                {s.heading || '（无标题节）'}
              </li>
            ))}
          </ul>
        )}
      </div>
      <PageNav count={pageCount} idx={page} setIdx={setPage} />
    </div>
  );
}

function PageNav({ count, idx, setIdx }: { count: number; idx: number; setIdx: (i: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        disabled={idx <= 0}
        onClick={() => setIdx(idx - 1)}
        className="px-2 py-0.5 text-[11px] text-muted rounded-capsule border border-line hover:text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ‹
      </button>
      <span className="text-[11px] text-muted min-w-10 text-center">
        {Math.min(idx + 1, count)} / {count}
      </span>
      <button
        disabled={idx >= count - 1}
        onClick={() => setIdx(idx + 1)}
        className="px-2 py-0.5 text-[11px] text-muted rounded-capsule border border-line hover:text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ›
      </button>
    </div>
  );
}
