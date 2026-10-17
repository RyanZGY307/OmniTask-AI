'use client';
import { useState, useRef, useEffect } from 'react';
import { useT } from '@/lib/i18n';

interface Props { onSend: (content: string) => void; isLoading: boolean; disabled?: boolean; initialContent?: string; onStop?: () => void; }

export default function MessageInput({ onSend, isLoading, disabled, initialContent, onStop }: Props) {
  const [content, setContent] = useState(initialContent || '');
  const [showAttach, setShowAttach] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const t = useT();

  useEffect(() => {
    setIsTouchDevice(typeof window !== 'undefined' && (navigator.maxTouchPoints > 0 || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)));
  }, []);

  const handleSend = () => {
    const trimmed = content.trim();
    if (!trimmed || isLoading || disabled) return;
    onSend(trimmed); setContent('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } };

  const handleInput = () => {
    const ta = textareaRef.current;
    if (ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; }
  };

  return (
    <div className="border-t border-border bg-surface p-4 relative" style={{ borderRadius: '20px 20px 0 0' }}>
      {showAttach && (
        <div className="absolute bottom-full left-4 mb-2 glass-card-sm p-2 anim-fade-up">
          <div className="flex gap-1">
            {[{ icon: '📎', label: '文件' }, { icon: '🖼️', label: '图片' }, { icon: '📄', label: '文档' }, { icon: '🎤', label: '语音' }, { icon: '📸', label: '拍照' }].map(item => (
              <button key={item.label} onClick={() => setShowAttach(false)} className="flex flex-col items-center gap-1 px-3 py-2 rounded-card hover:bg-surface-hover transition-colors anim-press">
                <span className="text-lg">{item.icon}</span><span className="text-xs text-muted">{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-2 items-end max-w-4xl mx-auto">
        <button onClick={() => setShowAttach(!showAttach)} className="p-3 bg-surface hover:bg-surface-hover rounded-card transition-colors flex-shrink-0 border border-border anim-press focus-ring" aria-label={t('chat.attach')}>
          <svg className="w-5 h-5 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
        </button>
        <textarea ref={textareaRef} value={content} onChange={(e) => setContent(e.target.value)} onKeyDown={handleKeyDown} onInput={handleInput}
          placeholder={isTouchDevice ? t('chat.inputPh') : t('chat.inputPhShift')} disabled={disabled} rows={1}
          className="flex-1 bg-bg border border-border rounded-card px-4 py-3 text-sm text-primary placeholder-muted resize-none focus:outline-none focus:border-accent/50 transition-all disabled:opacity-50" style={{ maxHeight: '160px' }} />
        <button
          onClick={() => { if (isLoading && onStop) onStop(); else handleSend(); }}
          disabled={isLoading ? !onStop : (!content.trim() || disabled)}
          aria-label={isLoading ? t('chat.stopGen') : t('chat.send')}
          title={isLoading ? t('chat.stopGen') : t('chat.send')}
          className={`p-3 rounded-card transition-all disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0 anim-hover-scale relative focus-ring ${isLoading ? 'bg-error text-white' : 'bg-accent hover:bg-accent-hover text-on-accent'}`}>
          <span className="relative block w-5 h-5">
            <svg className={`absolute inset-0 w-5 h-5 transition-all duration-300 ${isLoading ? 'opacity-0 scale-50' : 'opacity-100 scale-100'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
            <svg className={`absolute inset-0 w-5 h-5 transition-all duration-300 ${isLoading ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          </span>
        </button>
      </div>
    </div>
  );
}