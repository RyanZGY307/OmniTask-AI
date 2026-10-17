'use client';
import { useEffect, useMemo, useState } from 'react';
import { useChatStore, MediaConfirmMeta } from '@/store/chatStore';
import {
  IMAGE_MODELS_CONFIRM, IMAGE_RATIOS_CONFIRM, IMAGE_RESOLUTIONS_CONFIRM,
  VIDEO_MODEL_CONFIRM, VIDEO_RESOLUTION_CONFIRM, VIDEO_RATIOS_CONFIRM, VIDEO_SECONDS_CONFIRM,
} from '@/lib/models';

interface Props {
  message: {
    id: string;
    content: string;
    metadata?: any;
    createdAt: string;
  };
  isLast?: boolean;
}

export default function MediaConfirmCard({ message, isLast }: Props) {
  const { confirmMedia, pollVideoMessage, mediaConfirming } = useChatStore();
  const meta: MediaConfirmMeta | null = useMemo(() => {
    const raw = message.metadata;
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
  }, [message.metadata]);

  const isImage = meta?.kind === 'image-gen';
  const isVideo = meta?.kind === 'video-gen';
  const pending = meta?.status === 'pending';

  const prefill = useMemo(() => {
    const p = meta?.params || {};
    return {
      model: p.model || (isImage ? 'agnes-image-2.5-flash' : VIDEO_MODEL_CONFIRM),
      ratio: p.ratio || (isImage ? '' : ''),
      resolution: p.resolution || (isImage ? '' : ''),
      seconds: p.seconds != null ? String(p.seconds) : '',
      autoSelected: Boolean(p.model || p.ratio || p.resolution || p.seconds),
    };
  }, [meta, isImage, isVideo]);

  const [selModel, setSelModel] = useState(prefill.model);
  const [selRatio, setSelRatio] = useState(isImage ? (prefill.ratio || '1:1') : (prefill.ratio || '16:9'));
  const [selRes, setSelRes] = useState(isImage ? (prefill.resolution || '1K') : VIDEO_RESOLUTION_CONFIRM);
  const [selSeconds, setSelSeconds] = useState(isVideo ? (prefill.seconds || '5') : '');
  const [busy, setBusy] = useState(false);
  const [videoProgress, setVideoProgress] = useState<number | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);

  const prompt = meta?.prompt || message.content || '';

  // 若已确认且是视频，对结果消息启动轮询
  const resultMsgId: string | undefined = meta?.resultMessageId;
  useEffect(() => {
    if (isVideo && resultMsgId && meta?.status === 'confirmed') {
      setVideoProgress(0);
      pollVideoMessage(
        resultMsgId,
        (p) => setVideoProgress(p),
        (url) => setVideoUrl(url),
        () => setVideoFailed(true),
      );
    }
  }, [isVideo, resultMsgId, meta?.status]);

  const handleConfirm = async () => {
    if (busy || !pending) return;
    setBusy(true);
    const params: Record<string, any> = { prompt };
    if (isImage) {
      params.model = selModel;
      params.ratio = selRatio;
      params.resolution = selRes;
    } else {
      params.model = VIDEO_MODEL_CONFIRM;
      params.ratio = selRatio;
      params.seconds = Number(selSeconds);
      params.resolution = VIDEO_RESOLUTION_CONFIRM;
    }
    try {
      const r: any = await confirmMedia(message.id, params);
      if (r && r.messageId && isVideo) {
        setVideoProgress(0);
        pollVideoMessage(
          r.messageId,
          (p) => setVideoProgress(p),
          (url) => setVideoUrl(url),
          () => setVideoFailed(true),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const pill = (active: boolean) =>
    `px-3 py-1.5 rounded-capsule text-xs liquid-glass liquid-glass-interactive transition-all duration-200 ${active ? 'bg-accent/15 text-accent border border-accent/30' : 'text-muted hover:text-primary border border-transparent'}`;

  return (
    <div className="glass-card-sm p-4 space-y-3">
      {/* 提示词 */}
      <div>
        <div className="text-xs text-muted mb-1.5 flex items-center gap-1.5">
          <span>{isImage ? '🎨 图片提示词' : '🎬 视频提示词'}</span>
          {pending && prefill.autoSelected && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-capsule bg-warning/10 text-warning">已自动选中</span>
          )}
        </div>
        <p className="text-sm text-primary leading-relaxed">{prompt}</p>
      </div>

      {/* 待确认：参数选择 */}
      {pending && (
        <div className="space-y-2.5 anim-fade-up">
          {isImage && (
            <div>
              <div className="text-xs text-muted mb-1">模型</div>
              <div className="flex flex-wrap gap-1.5">
                {IMAGE_MODELS_CONFIRM.map(m => (
                  <button key={m.key} onClick={() => setSelModel(m.key)} className={pill(selModel === m.key)}>{m.displayName}</button>
                ))}
              </div>
            </div>
          )}
          {isVideo && (
            <div className="flex flex-wrap gap-1.5 text-xs text-muted">
              <span className="px-3 py-1.5 rounded-capsule bg-accent/10 text-accent border border-accent/20">{VIDEO_MODEL_CONFIRM}</span>
              <span className="px-3 py-1.5 rounded-capsule bg-accent/10 text-accent border border-accent/20">{VIDEO_RESOLUTION_CONFIRM}</span>
            </div>
          )}

          <div>
            <div className="text-xs text-muted mb-1">{isImage ? '比例' : '比例'}</div>
            <div className="flex flex-wrap gap-1.5">
              {(isImage ? IMAGE_RATIOS_CONFIRM : VIDEO_RATIOS_CONFIRM).map(r => (
                <button key={r} onClick={() => setSelRatio(r)} className={pill(selRatio === r)}>{r}</button>
              ))}
            </div>
          </div>

          {isImage && (
            <div>
              <div className="text-xs text-muted mb-1">分辨率</div>
              <div className="flex flex-wrap gap-1.5">
                {IMAGE_RESOLUTIONS_CONFIRM.map(r => (
                  <button key={r} onClick={() => setSelRes(r)} className={pill(selRes === r)}>{r === '1K' ? '1K / 1080P' : r}</button>
                ))}
              </div>
            </div>
          )}

          {isVideo && (
            <div>
              <div className="text-xs text-muted mb-1">时长</div>
              <div className="flex flex-wrap gap-1.5">
                {VIDEO_SECONDS_CONFIRM.map(s => (
                  <button key={s} onClick={() => setSelSeconds(String(s))} className={pill(selSeconds === String(s))}>{s}s</button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleConfirm}
              disabled={busy || mediaConfirming}
              className="flex-1 py-2.5 bg-accent text-on-accent text-sm rounded-card hover:bg-accent/90 transition-all duration-200 disabled:opacity-50 anim-hover-scale"
              style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
            >
              {busy ? '生成中…' : `确认生成${isImage ? '图片' : '视频'}`}
            </button>
          </div>
        </div>
      )}

      {/* 已确认：结果状态 */}
      {meta?.status === 'confirmed' && (
        <div className="space-y-2">
          {videoFailed && (
            <div className="text-xs text-error flex items-center gap-1.5">
              <span>✕</span> 视频生成失败
            </div>
          )}
          {isImage && !videoFailed && (
            <div className="text-xs text-success flex items-center gap-1.5">
              <span>✓</span> 已生成，见下方图片
            </div>
          )}
          {isVideo && !videoFailed && videoUrl && (
            <div className="anim-fade-up">
              <video src={videoUrl} controls className="rounded-lg max-w-full max-h-96" />
            </div>
          )}
          {isVideo && !videoFailed && !videoUrl && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs text-muted">
                <div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full anim-spin" />
                视频生成中 {videoProgress != null ? `· ${videoProgress}%` : ''}
              </div>
              <div className="w-full h-1.5 bg-surface rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all duration-500"
                  style={{ width: `${videoProgress ?? 0}%`, transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
