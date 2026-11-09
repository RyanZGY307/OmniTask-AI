'use client';
// 事件时间线：渲染服务端 toEventRows 的人话摘要行（唯一事实源 = 事件流）。
import type { TaskEventRowVM } from '@/lib/agentTypes';

const LEVEL_CLASS: Record<string, string> = {
  info: 'text-gray-600',
  warn: 'text-amber-700',
  error: 'text-red-600',
};

export default function TaskEventList({ rows }: { rows: TaskEventRowVM[] }) {
  if (!rows.length) return <p className="text-sm text-gray-400">暂无事件（等待 run 启动…）</p>;
  return (
    <ol className="space-y-1">
      {rows.map((r) => (
        <li key={r.seq} className="flex gap-2 text-sm border-b border-gray-100 pb-1">
          <span className="font-mono text-xs text-gray-400 w-10 shrink-0">#{r.seq}</span>
          <span className={`flex-1 ${LEVEL_CLASS[r.level] ?? 'text-gray-600'}`}>{r.summary}</span>
          <span className="text-xs text-gray-400 shrink-0">{new Date(r.ts).toLocaleTimeString('zh-CN')}</span>
        </li>
      ))}
    </ol>
  );
}
