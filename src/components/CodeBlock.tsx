'use client';
import { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface Props {
  code: string; language: string; messageId?: string;
  onDownloadCode?: (messageId: string) => void;
  multiFile?: boolean;
}

export default function CodeBlock({ code, language, messageId, onDownloadCode, multiFile }: Props) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // 超过 20 行的代码块默认折叠，减少首屏信息压力（P2）
  const lineCount = code.split('\n').length;
  const collapsible = lineCount > 20;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span>{language}</span>
        <div className="flex gap-2">
          <button onClick={handleCopy} className="flex items-center gap-1 px-2 py-1 rounded hover:bg-surface-light text-xs transition-colors anim-press">
            {copied ? <><svg className="w-3.5 h-3.5 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>已复制</> : <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>复制</>}
          </button>
          {messageId && onDownloadCode && (
            <button onClick={() => onDownloadCode(messageId)} className="flex items-center gap-1 px-2 py-1 rounded hover:bg-surface-light text-xs transition-colors anim-press">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              {multiFile ? 'ZIP' : '下载'}
            </button>
          )}
        </div>
      </div>
      <div className={collapsible && !expanded ? 'code-block-collapsed' : ''}>
        <SyntaxHighlighter language={language} style={oneDark}
          customStyle={{ margin: 0, borderRadius: 0, background: 'transparent', fontSize: '13px', lineHeight: '1.6', fontFamily: 'var(--font-mono, monospace)' }}
          lineNumberStyle={{ minWidth: '2.2em', color: 'rgba(148, 163, 184, 0.4)', fontSize: '11px', userSelect: 'none', paddingRight: '8px' }}
          showLineNumbers={lineCount <= 40}>{code}</SyntaxHighlighter>
      </div>
      {collapsible && !expanded && (
        <button onClick={() => setExpanded(true)} className="w-full py-2 text-xs text-accent hover:bg-surface-hover transition-colors border-t border-border/50">
          展开全部 {lineCount} 行 ▾
        </button>
      )}
      {expanded && (
        <button onClick={() => setExpanded(false)} className="w-full py-2 text-xs text-accent hover:bg-surface-hover transition-colors border-t border-border/50">
          收起 ▴
        </button>
      )}
    </div>
  );
}