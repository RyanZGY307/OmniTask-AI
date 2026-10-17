'use client';
import { useEffect, useRef } from 'react';

interface Props {
  x: number; y: number;
  onCopy: () => void; onEdit: () => void; onRetry: () => void; onClose: () => void;
}

export default function MessageContextMenu({ x, y, onCopy, onEdit, onRetry, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // position 必须写在行内：.context-menu-glass 自带 position:relative，会盖掉 Tailwind 的 fixed
  return (
    <div ref={ref} className="context-menu-glass z-50 min-w-[140px] p-1.5" style={{ position: 'fixed', left: Math.min(x, window.innerWidth - 160), top: Math.min(y, window.innerHeight - 160) }}>
      <button onClick={() => { onCopy(); onClose(); }} className="context-menu-item w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-primary">
        <span>📋</span> 复制
      </button>
      <button onClick={() => { onEdit(); onClose(); }} className="context-menu-item w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-primary">
        <span>✏️</span> 修改
      </button>
      <button onClick={() => { onRetry(); onClose(); }} className="context-menu-item w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-primary">
        <span>🔄</span> 重试
      </button>
    </div>
  );
}