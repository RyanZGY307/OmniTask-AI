'use client';
import { getApiUrl } from '@/lib/api';
import { useEffect, useMemo, useState } from 'react';
import { useChatStore, MediaConfirmMeta } from '@/store/chatStore';
import {
  TTS_MODELS_CONFIRM,
  AUDIO_FORMAT_LABELS,
  getTtsModel,
  formatInvalidForModel,
  type AudioFormat,
} from '@/lib/models';

// =====================================================================
// Audio Confirm Card — TTS generation spec card.
//
// Reuses the SAME visual system as MediaConfirmCard (image/video):
// the `glass-card-sm` container, `liquid-glass` + `rounded-capsule`
// selected pills, the accent-button confirm CTA, the same spacing /
// typography / responsive behavior. No new colors or glass constants
// are introduced — everything resolves through the shared CSS variables
// that the component-settings glass customizer drives.
//
// Data is registry-driven: model list + per-model format options +
// voice-design visibility all come from TTS_MODELS_CONFIRM (mirrored
// from the server capability registry). No provider names or model
// lists are hardcoded in JSX.
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

export default function AudioConfirmCard({ message }: Props) {
  const { confirmAudio, mediaConfirming, fetchMessages } = useChatStore();
  const meta: MediaConfirmMeta | null = useMemo(() => {
    const raw = message.metadata;
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
  }, [message.metadata]);

  const isAudio = meta?.kind === 'audio-gen';
  const pending = meta?.status === 'pending';
  const confirmed = meta?.status === 'confirmed';
  const failed = meta?.status === 'failed';

  // Prefill from the auto-fill (Context-Aware Intent) or previous state.
  const prefill = useMemo(() => {
    const p = meta?.params || {};
    const model = getTtsModel(p.model || '') ? p.model! : TTS_MODELS_CONFIRM[0].modelId;
    const m = getTtsModel(model)!;
    // If the prefilled format is invalid for the model, fall back to
    // the model's default (spec §六).
    let format = (p.format as AudioFormat) || m.defaultFormat;
    if (formatInvalidForModel(model, format)) format = m.defaultFormat;
    return {
      model,
      format,
      voiceDesign: p.voiceDesign || '',
      contentOverview: p.contentOverview || '',
      spokenText: p.spokenText || '',
      styleInstruction: p.styleInstruction || '',
      voiceReferenceId: p.voiceReferenceId,
      voiceId: p.voiceId,
      autoSelected: Boolean(p.model || p.format || p.voiceDesign || p.contentOverview || p.spokenText),
    };
  }, [meta]);

  const [selModel, setSelModel] = useState(prefill.model);
  const [selFormat, setSelFormat] = useState<AudioFormat>(prefill.format);
  const [voiceDesign, setVoiceDesign] = useState(prefill.voiceDesign);
  const [contentOverview, setContentOverview] = useState(prefill.contentOverview);
  const [busy, setBusy] = useState(false);
  const [audioResult, setAudioResult] = useState<any>(null);
  const [audioFailed, setAudioFailed] = useState<{ errorType?: string; error?: string } | null>(null);

  const model = getTtsModel(selModel) ?? TTS_MODELS_CONFIRM[0];
  const supportedFormats = model.supportedFormats;
  const showVoiceDesign = model.supportsVoiceDesign;

  // On model switch: if the currently-selected format is now illegal,
  // snap to the new model's default format (spec §六.3). This is the
  // ONLY place format auto-reset happens in the UI.
  useEffect(() => {
    if (formatInvalidForModel(selModel, selFormat)) {
      setSelFormat(model.defaultFormat);
    }
  }, [selModel, selFormat, model]);

  // When the user has switched to a model that doesn't support voice
  // design, the design text is NOT discarded — it is carried forward
  // as styleInstruction so no information is lost (spec §十 / §十四).
  const effectiveStyleInstruction = (() => {
    if (model.supportsVoiceDesign && showVoiceDesign) {
      // Voice-design model: design channel + any delivery cue merge.
      return [voiceDesign.trim(), prefill.styleInstruction?.trim()].filter(Boolean).join(', ');
    }
    // Non-voice-design model: any design text degrades to a style cue.
    return [voiceDesign.trim(), prefill.styleInstruction?.trim()].filter(Boolean).join(', ');
  })();

  // Confirm button enabled only when the request is well-formed:
  //  - content present (contentOverview OR spokenText)
  //  - voice-clone model has a voice reference (else show explicit state)
  //  - format valid for the model (guaranteed by the effect above)
  const hasContent = !!(contentOverview.trim() || prefill.spokenText?.trim() || meta?.prompt);
  const missingVoiceRef = model.requiresVoiceReference && !selModelHasVoiceReference();
  const canConfirm = pending && !busy && !mediaConfirming && hasContent && !missingVoiceRef;

  function selModelHasVoiceReference(): boolean {
    return Boolean(prefill.voiceReferenceId || prefill.voiceId);
  }

  const handleConfirm = async () => {
    if (!canConfirm) {
      if (missingVoiceRef) setAudioFailed({ errorType: 'MISSING_VOICE_REFERENCE', error: `${model.displayName} 需要声音参考：请先上传参考音频。` });
      return;
    }
    setBusy(true);
    setAudioFailed(null);
    const params: Record<string, any> = {
      model: selModel,
      format: selFormat,
      voiceDesign: showVoiceDesign ? voiceDesign.trim() : undefined,
      styleInstruction: showVoiceDesign ? prefill.styleInstruction || undefined : effectiveStyleInstruction || undefined,
      contentOverview: contentOverview.trim() || undefined,
      spokenText: prefill.spokenText?.trim() || undefined,
      voiceReferenceId: prefill.voiceReferenceId,
      voiceId: prefill.voiceId,
      prompt: meta?.prompt,
    };
    try {
      const r: any = await confirmAudio(message.id, params);
      if (r?.ok && r.artifactId) {
        setAudioResult({
          artifactId: r.artifactId,
          messageId: r.messageId,
          playbackUrl: r.playbackUrl,
          downloadUrl: r.downloadUrl,
          mimeType: r.mimeType,
          playbackMime: r.playbackMime,
          format: r.format,
          hasPlaybackRepresentation: r.hasPlaybackRepresentation,
          size: r.size,
          duration: r.duration,
          model: r.actualModel,
        });
      } else {
        setAudioFailed({ errorType: r?.errorType, error: r?.error || '音频生成失败' });
      }
    } catch {
      setAudioFailed({ errorType: 'STORAGE_ERROR', error: '音频生成失败' });
    } finally {
      setBusy(false);
    }
  };

  // Shared pill style — identical to MediaConfirmCard so the two cards
  // read as one component system.
  const pill = (active: boolean) =>
    `px-3 py-1.5 rounded-capsule text-xs liquid-glass liquid-glass-interactive transition-[background-color,border-color,box-shadow,opacity,transform,color] duration-200 ${active ? 'bg-accent/15 text-accent border border-accent/30' : 'text-muted hover:text-primary border border-transparent'}`;

  return (
    <div className="glass-card-sm p-4 space-y-3">
      {/* 音频提示词 */}
      <div>
        <div className="text-xs text-muted mb-1.5 flex items-center gap-1.5">
          <span>🎵 音频提示词</span>
          {pending && prefill.autoSelected && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-capsule bg-warning/10 text-warning">已自动选中</span>
          )}
        </div>
        <p className="text-sm text-primary leading-relaxed">{meta?.prompt || message.content || ''}</p>
      </div>

      {pending && (
        <div className="space-y-2.5 anim-fade-up">
          {/* 模型 — registry-driven, one at a time */}
          <div>
            <div className="text-xs text-muted mb-1">模型</div>
            <div className="flex flex-wrap gap-1.5">
              {TTS_MODELS_CONFIRM.map((m) => (
                <button key={m.modelId} onClick={() => setSelModel(m.modelId)} className={pill(selModel === m.modelId)}>
                  {m.displayName}
                </button>
              ))}
            </div>
          </div>

          {/* 音频格式 — 按当前模型动态过滤 */}
          <div>
            <div className="text-xs text-muted mb-1">音频格式</div>
            <div className="flex flex-wrap gap-1.5">
              {supportedFormats.map((f) => (
                <button key={f} onClick={() => setSelFormat(f)} className={pill(selFormat === f)}>
                  {AUDIO_FORMAT_LABELS[f]}
                </button>
              ))}
            </div>
          </div>

          {/* 音色设计 — 只有 supportsVoiceDesign 模型才显示 */}
          {showVoiceDesign ? (
            <div>
              <div className="text-xs text-muted mb-1">音色设计</div>
              <input
                value={voiceDesign}
                onChange={(e) => setVoiceDesign(e.target.value)}
                placeholder="例如：年轻、温暖、有磁性的男性声音"
                className="w-full bg-surface border border-line rounded-card px-3 py-2 text-sm text-primary placeholder:text-muted/50 focus:outline-none focus:border-accent/50 transition-colors"
              />
            </div>
          ) : null}

          {/* 音频内容概述 */}
          <div>
            <div className="text-xs text-muted mb-1">音频内容概述</div>
            <input
              value={contentOverview}
              onChange={(e) => setContentOverview(e.target.value)}
              placeholder="要朗读 / 生成的内容"
              className="w-full bg-surface border border-line rounded-card px-3 py-2 text-sm text-primary placeholder:text-muted/50 focus:outline-none focus:border-accent/50 transition-colors"
            />
          </div>

          {/* VoiceClone 缺参考：明确状态，不假成功 */}
          {missingVoiceRef && (
            <div className="text-xs text-error flex items-center gap-1.5">
              <span>⚠</span> 缺少声音参考（Voice Clone 需要先上传参考音频）
            </div>
          )}

          {/* 确认按钮 — 状态机同图片/视频卡 */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleConfirm}
              disabled={busy || mediaConfirming || missingVoiceRef || !hasContent}
              className="flex-1 py-2.5 bg-accent text-on-accent text-sm rounded-card hover:bg-accent/90 transition-[background-color,border-color,box-shadow,opacity,transform,color] duration-200 disabled:opacity-50 anim-hover-scale"
              style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
            >
              {busy ? '生成中…' : '确认生成音频'}
            </button>
          </div>
        </div>
      )}

      {/* 结果状态 */}
      {confirmed && audioResult?.messageId && (
        <AudioPlayer
          messageId={audioResult.messageId}
          artifact={audioResult}
        />
      )}
      {(failed || audioFailed) && !audioResult && (
        <div className="text-xs text-error flex items-center gap-1.5">
          <span>✕</span> 音频生成失败{audioFailed?.errorType ? `（${audioFailed.errorType}）` : ''}
        </div>
      )}
      {confirmed && !audioResult && (
        <AudioPlayerInline message={message} />
      )}
    </div>
  );
}

// =====================================================================
// In-conversation Audio Player — the artifact rendered inside chat.
// Uses the browser-playable representation; download always pulls the
// ORIGINAL user-selected format. Survives refresh because it re-reads
// from the server (no blob / React-state source of truth).
// =====================================================================

function AudioPlayer({ messageId, artifact }: { messageId: string; artifact: any }) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('cortex_token') : null;
  const base = getApiUrl();
  const playbackSrc = artifact?.playbackUrl ? `${base}${artifact.playbackUrl}` : null;
  const downloadHref = artifact?.downloadUrl ? `${base}${artifact.downloadUrl}` : null;

  return (
    <div className="liquid-glass rounded-card p-3 space-y-2 max-w-md">
      <div className="text-xs text-muted flex items-center gap-1.5">
        <span>🎵</span> 音频
        <span className="text-[10px] text-muted/70">{artifact?.format ? AUDIO_FORMAT_LABELS[artifact.format as AudioFormat] || artifact.format : ''}</span>
      </div>
      {playbackSrc ? (
        <audio src={playbackSrc} controls className="w-full h-10" preload="metadata" />
      ) : (
        <div className="text-xs text-muted">播放器暂不可用</div>
      )}
      {downloadHref && (
        <a
          href={downloadHref}
          target="_blank"
          rel="noreferrer"
          download
          className="text-xs text-accent hover:text-accent/80 transition-colors"
        >
          下载原始文件 {artifact?.hasPlaybackRepresentation ? '（原始 ≠ 播放版本）' : ''}
        </a>
      )}
    </div>
  );
}

// Fallback renderer used when the card was confirmed in a previous
// session and the in-memory `audioResult` is gone: re-derive the
// playback/download endpoints from the message id.
function AudioPlayerInline({ message }: { message: Props['message'] }) {
  const base = getApiUrl();
  const meta = message.metadata;
  const m: any = typeof meta === 'object' ? meta : (() => { try { return JSON.parse(meta as string); } catch { return null; } })();
  const messageId = m?.resultMessageId || message.id;
  const playbackSrc = `${base}/chat/audio/${messageId}/playback`;
  const downloadHref = `${base}/chat/audio/${messageId}/download`;
  return (
    <div className="liquid-glass rounded-card p-3 space-y-2 max-w-md">
      <div className="text-xs text-muted flex items-center gap-1.5">
        <span>🎵</span> 音频
        {m?.format ? <span className="text-[10px] text-muted/70">{AUDIO_FORMAT_LABELS[m.format as AudioFormat] || m.format}</span> : null}
      </div>
      <audio src={playbackSrc} controls className="w-full h-10" preload="metadata" />
      <a href={downloadHref} target="_blank" rel="noreferrer" download className="text-xs text-accent hover:text-accent/80 transition-colors">
        下载原始文件
      </a>
    </div>
  );
}
