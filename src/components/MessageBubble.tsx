'use client';
import { getApiUrl } from '@/lib/api';
import { useState, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';
import MessageContextMenu from './MessageContextMenu';
import MediaConfirmCard from './MediaConfirmCard';
import AudioConfirmCard from './AudioConfirmCard';
import OfficeConfirmCard from './OfficeConfirmCard';
import OfficePreview from './OfficePreview';
import { getModelDisplayName, formatTokenCount, AUDIO_FORMAT_LABELS, type AudioFormat } from '@/lib/models';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  messageType: string;
  model?: string;
  metadata?: any;
  tokenCount?: number;
  creditsCost?: number;
  createdAt: string;
}

interface Props {
  message: Message;
  isStreaming?: boolean;
  isLast?: boolean;
  onDownloadCode?: (messageId: string) => void;
  onCopy?: (content: string) => void;
  onEdit?: (content: string) => void;
  onRetry?: () => void;
}

export default function MessageBubble({
  message, isStreaming, isLast, onDownloadCode, onCopy, onEdit, onRetry,
}: Props) {
  const isUser = message.role === 'user';
  const isImage = message.messageType === 'image' && message.metadata?.imageUrl;
  const isVideo = message.messageType === 'video';
  const isAudio = message.messageType === 'audio';
  const isOffice = message.messageType === 'office';
  const isResearch = message.messageType === 'research';
  const isTool = message.messageType === 'tool';
  const isMediaConfirm = message.messageType === 'media_confirm';
  const isOfficeConfirm = isMediaConfirm && message.metadata?.kind === 'office-gen';
  const hasCode = message.metadata?.codeBlocks?.length > 0;
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout>>();
  const modelDisplayName = getModelDisplayName(message.model);
  const tokenCount = message.tokenCount ?? 0;
  const creditsCost = message.creditsCost ?? 0;
  const hasDetails = !isUser && (tokenCount > 0 || creditsCost > 0);
  // metadata 可能是对象或 JSON 字符串，统一解析一次（含安全标记）
  const meta: any = (() => {
    if (message.metadata && typeof message.metadata === 'object') return message.metadata;
    try { return message.metadata ? JSON.parse(message.metadata as any) : null; } catch { return null; }
  })();
  const safetyFlag: { level: string; uploadedPairs: number; uploadStatus?: 'pending' | 'ok' | 'failed' } | undefined = meta?.safetyFlag;
  const safetyWarning: number = typeof meta?.safetyWarning === 'number' ? meta.safetyWarning : 0;

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!isUser && isLast) {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }
    },
    [isUser, isLast],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!isUser && isLast) {
        longPressTimer.current = setTimeout(() => {
          const touch = e.touches[0];
          setContextMenu({ x: touch.clientX, y: touch.clientY });
        }, 500);
      }
    },
    [isUser, isLast],
  );

  const handleTouchEnd = useCallback(() => {
    clearTimeout(longPressTimer.current);
  }, []);

  return (
    <>
      <div
        className={`${isStreaming ? '' : 'anim-fade-up'} flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Avatar */}
        <div
          className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-sm font-bold ${
            isUser ? 'bg-accent text-on-accent' : 'bg-surface-hover text-accent-figure'
          }`}
        >
          {isUser ? 'U' : isResearch ? '🔬' : 'C'}
        </div>

        {/* Content */}
        <div className={`flex-1 max-w-[85%] ${isUser ? 'flex flex-col items-end' : ''}`}>
          {isMediaConfirm ? (
            // 音频规格卡与图片/视频卡同一 glass-card 体系，kind 区分渲染
            (message.metadata?.kind === 'audio-gen' || message.metadata?.kind === 'audio') ? (
              <AudioConfirmCard message={message} isLast={isLast} />
            ) : isOfficeConfirm ? (
              <OfficeConfirmCard message={message} isLast={isLast} />
            ) : (
              <MediaConfirmCard message={message} isLast={isLast} />
            )
          ) : (
          <div
            className={`rounded-2xl px-4 py-3 ${
              isUser ? 'bg-surface-hover border border-border text-primary' : 'glass-card-sm'
            } ${isResearch ? 'border-accent/20' : ''} ${isTool ? 'border-warning/20' : ''}`}
          >
            {/* Image */}
            {isImage && (
              <div className="mb-3">
                <img
                  src={message.metadata.imageUrl}
                  alt={message.metadata.prompt || 'Generated'}
                  className="rounded-lg max-w-full h-auto max-h-96 object-contain"
                  loading="lazy"
                />
              </div>
            )}

            {/* Video */}
            {isVideo && message.metadata?.videoUrl && (
              <div className="mb-3">
                <video src={message.metadata.videoUrl} controls className="rounded-lg max-w-full max-h-96" />
              </div>
            )}
            {isVideo && message.metadata?.status === 'processing' && (
              <div className="flex items-center gap-2 text-accent mb-3">
                <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full anim-spin" />
                <span className="text-sm">视频生成中...</span>
              </div>
            )}

            {/* Audio — 一等 Artifact：播放 + 下载原始格式。数据来自
                服务端持久化的 AudioArtifact（刷新后仍可用）。 */}
            {isAudio && (() => {
              const m: any = typeof message.metadata === 'object'
                ? message.metadata
                : (() => { try { return JSON.parse(message.metadata as string); } catch { return null; } })();
              if (!m || m.status !== 'done' || !m.messageId && !m.artifactId) {
                if (m && m.status === 'failed') {
                  return (
                    <div className="text-xs text-error flex items-center gap-1.5 mb-2">
                      <span>✕</span> 音频生成失败{m.failureReason ? `（${m.failureReason}）` : ''}
                    </div>
                  );
                }
                return null;
              }
              const base = getApiUrl();
              const msgId = m.messageId || m.artifactId;
              const playbackSrc = m.playbackUrl ? `${base}${m.playbackUrl}` : `${base}/chat/audio/${msgId}/playback`;
              const downloadHref = m.downloadUrl ? `${base}${m.downloadUrl}` : `${base}/chat/audio/${msgId}/download`;
              const fmt = m.format ? AUDIO_FORMAT_LABELS[m.format as AudioFormat] || m.format : '';
              return (
                <div className="liquid-glass rounded-card p-3 space-y-2 max-w-md mb-2">
                  <div className="text-xs text-muted flex items-center gap-1.5">
                    <span>🎵</span> 音频
                    {fmt && <span className="text-[10px] text-muted/70">{fmt}</span>}
                  </div>
                  <audio src={playbackSrc} controls className="w-full h-10" preload="metadata" />
                  <div className="flex items-center justify-between gap-2">
                    <a href={downloadHref} target="_blank" rel="noreferrer" download className="text-xs text-accent hover:text-accent/80 transition-colors">
                      下载原始文件{m.hasPlaybackRepresentation ? '（≠ 播放版本）' : ''}
                    </a>
                    {m.size ? <span className="text-[10px] text-muted">{(m.size / 1024).toFixed(1)} KB</span> : null}
                  </div>
                </div>
              );
            })()}

            {/* Office artifact — 一等 Artifact：预览（派生表示）+ 下载原始格式。
                数据来自服务端持久化的 OfficeArtifact（刷新后仍可用）。 */}
            {isOffice && (() => {
              const m: any = typeof message.metadata === 'object'
                ? message.metadata
                : (() => { try { return JSON.parse(message.metadata as string); } catch { return null; } })();
              if (!m) return null;
              if (m.status === 'failed') {
                return (
                  <div className="text-xs text-error flex items-center gap-1.5 mb-2">
                    <span>✕</span> 文件生成失败{m.failureReason ? `（${m.failureReason}）` : ''}
                  </div>
                );
              }
              return (
                <OfficePreview
                  messageId={message.id}
                  type={m.type}
                  format={m.format}
                  filename={m.filename}
                  size={m.size}
                  pageCount={m.pageCount}
                />
              );
            })()}

            {/* Tool result */}
            {isTool && message.metadata?.toolResult && (
              <div className="mb-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs px-2 py-0.5 rounded bg-warning/10 text-warning border border-warning/20">
                    🧮 {message.metadata.toolResult.tool}
                  </span>
                  {message.metadata.toolResult.success !== undefined && (
                    <span className={`text-xs ${message.metadata.toolResult.success ? 'text-success' : 'text-error'}`}>
                      {message.metadata.toolResult.success ? '✓ 成功' : '✕ 失败'}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Model badge */}
            {modelDisplayName && !isUser && (
              <div className="mb-2">
                <span className="text-[11px] px-2 py-0.5 rounded-capsule bg-surface text-muted border border-border">
                  {isResearch ? '🔬 深度研究' : modelDisplayName}
                </span>
              </div>
            )}

            {/* Research badge */}
            {isResearch && !message.model && (
              <div className="mb-2">
                <span className="text-xs px-2 py-0.5 rounded-capsule bg-accent/10 text-accent border border-accent/20">
                  🔬 深度研究报告
                </span>
              </div>
            )}

            {/* 中-高敏感警告条：第 1~3 次警告（随正常回复显示） */}
            {safetyWarning > 0 && !isUser && (
              <div className="mb-2 rounded-lg border border-warning/40 bg-warning/10 text-warning px-3 py-2 text-xs">
                该内容涉及中-高敏感话题，这是第 {safetyWarning} 次警告
              </div>
            )}

            {/* Markdown content */}
            <div className="markdown-content text-sm leading-relaxed">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ node, inline, className, children, ...props }: any) {
                    const match = /language-(\w+)/.exec(className || '');
                    const codeString = String(children).replace(/\n$/, '');
                    if (!inline && match) {
                      return (
                        <CodeBlock
                          code={codeString}
                          language={match[1]}
                          messageId={message.id}
                          onDownloadCode={onDownloadCode}
                          multiFile={hasCode && message.metadata.codeBlocks.length > 1}
                        />
                      );
                    }
                    return (
                      <code className={className} {...props}>
                        {children}
                      </code>
                    );
                  },
                }}
              >
                {message.content}
              </ReactMarkdown>
              {isStreaming && <span className="typing-cursor" />}
            </div>

            {/* 敏感标记红框：拒绝回答时显示于 AI 回复下方；文案由后端真实提交状态驱动 */}
            {safetyFlag && !isUser && !isStreaming && (
              <div className="mt-2 rounded-card border-[1.5px] border-error px-3 py-2 text-xs text-error">
                {safetyFlag.uploadStatus === 'pending'
                  ? `对话已被标记，正在上传最近 ${safetyFlag.uploadedPairs} 条对话…`
                  : safetyFlag.uploadStatus === 'failed'
                    ? `对话已被标记，最近 ${safetyFlag.uploadedPairs} 条对话上传失败（将按安全重试机制处理）`
                    : `对话已被标记，最近 ${safetyFlag.uploadedPairs} 条对话已上传至后台`}
              </div>
            )}

            {/* Code blocks download */}
            {hasCode && !isStreaming && (
              <div className="mt-3 flex gap-2">
                {message.metadata.codeBlocks.length === 1 ? (
                  <button onClick={() => onDownloadCode?.(message.id)} className="file-download-btn">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    {message.metadata.codeBlocks[0].name}
                  </button>
                ) : (
                  <button onClick={() => onDownloadCode?.(message.id)} className="file-download-btn">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    下载 ZIP ({message.metadata.codeBlocks.length}个文件)
                  </button>
                )}
              </div>
            )}
          </div>
          )}

          {/* Meta info */}
          <div
            className={`flex items-center gap-2 mt-1 ${isUser ? 'flex-row-reverse' : ''} ${hasDetails ? 'cursor-pointer' : ''}`}
            onClick={() => hasDetails && setShowDetails(v => !v)}
            role={hasDetails ? 'button' : undefined}
          >
            <span className="text-[11px] num text-muted">
              {new Date(message.createdAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            {!isUser && creditsCost > 0 && (
              <span className="cost-indicator">-{Math.floor(creditsCost)} 积分</span>
            )}
            {hasDetails && (
              <span className="text-[11px] text-muted/60">{showDetails ? '收起' : '详情'}</span>
            )}
          </div>
          {/* Expanded details: tokens & cost */}
          {!isUser && hasDetails && showDetails && (
            <div className={`flex items-center gap-2 mt-0.5 text-[11px] num text-muted/70 ${isUser ? 'justify-end' : ''}`}>
              {tokenCount > 0 && <span>{formatTokenCount(tokenCount)} tokens</span>}
              {creditsCost > 0 && <span>· 消耗 {Math.floor(creditsCost)} 积分</span>}
            </div>
          )}
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && !isUser && isLast && (
        <MessageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onCopy={() => onCopy?.(message.content)}
          onEdit={() => onEdit?.(message.content)}
          onRetry={() => onRetry?.()}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}