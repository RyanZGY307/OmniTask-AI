'use client';
import { useEffect, useMemo, useState } from 'react';
import { useChatStore, MediaConfirmMeta } from '@/store/chatStore';
import OfficePreview from './OfficePreview';
import {
  OFFICE_FORMAT_LABELS,
  OFFICE_TYPE_LABELS,
  OFFICE_DOCUMENT_TYPES,
  OFFICE_DOCUMENT_TYPE_LABELS,
  officeFormatsForType,
  defaultOfficeFormat,
  type OfficeArtifactType,
  type OfficeFormat,
} from '@/lib/models';

// =====================================================================
// Office Confirm Card — generation spec card for PPT / Doc / Spreadsheet.
//
// Reuses the SAME visual system as AudioConfirmCard / MediaConfirmCard:
// the `glass-card-sm` container, `liquid-glass` + `rounded-capsule`
// selected pills, the accent-button confirm CTA, identical spacing /
// typography / responsive behavior. No new colors or glass constants —
// everything resolves through the shared CSS variables.
//
// Data is registry-driven: the supported output formats per artifact
// type + default format come from OFFICE_FORMATS_BY_TYPE (mirrored from
// the server office/types.ts). No format lists are hardcoded in JSX.
// =====================================================================

interface Props {
  message: {
    id: string;
    content: string;
    metadata?: any;
    createdAt: string;
  };
  isLast?: boolean;
}

const TYPES: OfficeArtifactType[] = ['presentation', 'document', 'spreadsheet'];

export default function OfficeConfirmCard({ message }: Props) {
  const { confirmOffice, mediaConfirming } = useChatStore();
  const meta: MediaConfirmMeta | null = useMemo(() => {
    const raw = message.metadata;
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
  }, [message.metadata]);

  const pending = meta?.status === 'pending';
  const confirmed = meta?.status === 'confirmed';
  const failed = meta?.status === 'failed';

  // Prefill from the auto-fill (intent gate) or previous state.
  const prefill = useMemo(() => {
    const p = meta?.params || {};
    let type: OfficeArtifactType =
      (p.artifactType as OfficeArtifactType) || 'document';
    if (!TYPES.includes(type)) type = 'document';
    let format: OfficeFormat =
      (p.format as OfficeFormat) || defaultOfficeFormat(type);
    if (!officeFormatsForType(type).includes(format)) {
      format = defaultOfficeFormat(type);
    }
    return {
      type,
      format,
      contentOverview: p.contentOverview || '',
      title: p.title || '',
      audience: p.audience || '',
      pageOrSlideCount: p.pageOrSlideCount,
      documentType: p.documentType || '',
      style: p.style || '',
      operation: p.operation || 'generate',
      targetRef: p.targetRef,
      sourceArtifactHint: p.sourceArtifactHint === true,
      autoSelected: Boolean(
        p.artifactType || p.format || p.contentOverview || p.pageOrSlideCount,
      ),
    };
  }, [meta]);

  const [selType, setSelType] = useState<OfficeArtifactType>(prefill.type);
  const [selFormat, setSelFormat] = useState<OfficeFormat>(prefill.format);
  const [contentOverview, setContentOverview] = useState(prefill.contentOverview);
  const [pageOrSlideCount, setPageOrSlideCount] = useState<string>(
    prefill.pageOrSlideCount ? String(prefill.pageOrSlideCount) : '',
  );
  const [documentType, setDocumentType] = useState(
    prefill.documentType && OFFICE_DOCUMENT_TYPES.includes(prefill.documentType as any)
      ? prefill.documentType
      : '',
  );
  const [busy, setBusy] = useState(false);
  const [officeResult, setOfficeResult] = useState<any>(null);
  const [officeFailed, setOfficeFailed] = useState<{ errorType?: string; error?: string } | null>(null);

  const supportedFormats = officeFormatsForType(selType);

  // On artifact-type switch: snap the format to the type's default when
  // the selected format is no longer legal for the new type.
  useEffect(() => {
    if (!officeFormatsForType(selType).includes(selFormat)) {
      setSelFormat(defaultOfficeFormat(selType));
    }
  }, [selType, selFormat]);

  const pageCountParsed = pageOrSlideCount.trim()
    ? Math.max(1, Math.min(200, parseInt(pageOrSlideCount, 10) || 1))
    : undefined;

  const hasContent = !!(contentOverview.trim() || meta?.prompt);
  const canConfirm = pending && !busy && !mediaConfirming && hasContent;

  const pill = (active: boolean) =>
    `px-3 py-1.5 rounded-capsule text-xs liquid-glass liquid-glass-interactive transition-[background-color,border-color,box-shadow,opacity,transform,color] duration-200 ${active ? 'bg-accent/15 text-accent border border-accent/30' : 'text-muted hover:text-primary border border-transparent'}`;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setBusy(true);
    setOfficeFailed(null);
    const params: Record<string, any> = {
      artifactType: selType,
      format: selFormat,
      contentOverview: contentOverview.trim(),
      title: meta?.params?.title || undefined,
      audience: meta?.params?.audience || undefined,
      documentType: selType === 'document' ? documentType || undefined : undefined,
      style: meta?.params?.style || undefined,
      prompt: meta?.prompt,
      // 基于既有文件修改时透传目标与操作类型（源 id 由后端按归属解析后写入卡片）
      sourceArtifactId: meta?.params?.sourceArtifactId || undefined,
      operation: meta?.params?.operation || undefined,
      targetRef: meta?.params?.targetRef || undefined,
    };
    if (pageCountParsed !== undefined) params.pageOrSlideCount = pageCountParsed;
    try {
      const r: any = await confirmOffice(message.id, params);
      if (r?.ok && r.artifactId) {
        setOfficeResult({
          artifactId: r.artifactId,
          messageId: r.messageId,
          format: r.format,
          pageCount: r.pageCount,
          size: r.size,
          downloadUrl: r.downloadUrl,
          previewUrl: r.previewUrl,
        });
      } else {
        setOfficeFailed({ errorType: r?.errorType, error: r?.error || '生成失败' });
      }
    } catch {
      setOfficeFailed({ errorType: 'STORAGE_ERROR', error: '生成失败' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass-card-sm p-4 space-y-3">
      {/* 办公文档提示词 */}
      <div>
        <div className="text-xs text-muted mb-1.5 flex items-center gap-1.5">
          <span>📄 办公文档</span>
          {pending && prefill.autoSelected && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-capsule bg-warning/10 text-warning">已自动选中</span>
          )}
        </div>
        <p className="text-sm text-primary leading-relaxed">{meta?.prompt || message.content || ''}</p>
      </div>

      {pending && (
        <div className="space-y-2.5 anim-fade-up">
          {/* 文档类型 */}
          <div>
            <div className="text-xs text-muted mb-1">文档类型</div>
            <div className="flex flex-wrap gap-1.5">
              {TYPES.map((t) => (
                <button key={t} onClick={() => setSelType(t)} className={pill(selType === t)}>
                  {OFFICE_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {/* 输出格式 — 按当前文档类型动态过滤 */}
          <div>
            <div className="text-xs text-muted mb-1">输出格式</div>
            <div className="flex flex-wrap gap-1.5">
              {supportedFormats.map((f) => (
                <button key={f} onClick={() => setSelFormat(f)} className={pill(selFormat === f)}>
                  {OFFICE_FORMAT_LABELS[f]}
                </button>
              ))}
            </div>
          </div>

          {/* 内容概述 */}
          <div>
            <div className="text-xs text-muted mb-1">内容概述</div>
            <input
              value={contentOverview}
              onChange={(e) => setContentOverview(e.target.value)}
              placeholder="要生成的内容"
              className="w-full bg-surface border border-line rounded-card px-3 py-2 text-sm text-primary placeholder:text-muted/50 focus:outline-none focus:border-accent/50 transition-colors"
            />
          </div>

          {/* 页数 / 幻灯片数（演示文稿与文档） */}
          {selType !== 'spreadsheet' && (
            <div>
              <div className="text-xs text-muted mb-1">{selType === 'presentation' ? '幻灯片数' : '页数'}</div>
              <input
                value={pageOrSlideCount}
                onChange={(e) => setPageOrSlideCount(e.target.value)}
                placeholder={selType === 'presentation' ? '例如 10' : '例如 12'}
                inputMode="numeric"
                className="w-28 bg-surface border border-line rounded-card px-3 py-2 text-sm text-primary placeholder:text-muted/50 focus:outline-none focus:border-accent/50 transition-colors"
              />
            </div>
          )}

          {/* 文档子类型（仅文档） */}
          {selType === 'document' && (
            <div>
              <div className="text-xs text-muted mb-1">文档子类型</div>
              <div className="flex flex-wrap gap-1.5">
                {OFFICE_DOCUMENT_TYPES.map((dt) => (
                  <button key={dt} onClick={() => setDocumentType(dt)} className={pill(documentType === dt)}>
                    {OFFICE_DOCUMENT_TYPE_LABELS[dt]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 确认按钮 */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleConfirm}
              disabled={busy || mediaConfirming || !hasContent}
              className="flex-1 py-2.5 bg-accent text-on-accent text-sm rounded-card hover:bg-accent/90 transition-[background-color,border-color,box-shadow,opacity,transform,color] duration-200 disabled:opacity-50 anim-hover-scale"
              style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
            >
              {busy ? '生成中…' : '确认生成'}
            </button>
          </div>
        </div>
      )}

      {/* 结果状态 */}
      {confirmed && officeResult?.messageId && (
        <OfficePreview
          messageId={officeResult.messageId}
          type={officeResult.kind}
          format={officeResult.format}
          pageCount={officeResult.pageCount}
          size={officeResult.size}
        />
      )}
      {(failed || officeFailed) && !officeResult && (
        <div className="text-xs text-error flex items-center gap-1.5">
          <span>✕</span> 生成失败{officeFailed?.errorType ? `（${officeFailed.errorType}）` : ''}
        </div>
      )}
      {confirmed && !officeResult && (
        <OfficePreviewInline message={message} />
      )}
    </div>
  );
}

// Fallback renderer used when the card was confirmed in a previous
// session and the in-memory `officeResult` is gone: re-derive the
// result message id from the confirm-card metadata and hand off to the
// shared OfficePreview viewer.
function OfficePreviewInline({ message }: { message: Props['message'] }) {
  const meta = message.metadata;
  const m: any = typeof meta === 'object' ? meta : (() => { try { return JSON.parse(meta as string); } catch { return null; } })();
  const messageId = m?.resultMessageId || message.id;
  return <OfficePreview messageId={messageId} type={m?.type} format={m?.format} />;
}
