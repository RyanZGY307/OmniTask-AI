'use client';
// 任务卡片：纯渲染 TaskCardVM（服务端从事件流投影）。不推断、不乐观更新。
import type { TaskCardVM } from '@/lib/agentTypes';
import { PHASE_META, phaseBadgeClass } from '@/lib/agentTypes';

export default function TaskCard({ card, running }: { card: TaskCardVM; running?: boolean }) {
  const meta = PHASE_META[card.phase] ?? { label: card.phase, tone: 'gray' as const };
  return (
    <div className="border rounded-lg p-3 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-xs text-gray-500 truncate">{card.runId}</div>
        <span className={phaseBadgeClass(card.phase)}>
          {meta.label}{running ? ' · 执行中' : ''}
        </span>
      </div>
      <div className="mt-2 text-sm text-gray-800 flex flex-wrap gap-x-4 gap-y-1">
        {card.patternLabel && <span>架构：{card.patternLabel}</span>}
        <span>步骤：{card.steps}</span>
        {card.approvalsPending > 0 && <span className="text-amber-700">待审批：{card.approvalsPending}</span>}
        {card.userInputsPending > 0 && <span className="text-amber-700">待回答：{card.userInputsPending}</span>}
        {card.downgradedFrom && <span className="text-purple-700">降级自：{card.downgradedFrom}</span>}
      </div>
      {card.phase === 'completed' && card.finalText && (
        <p className="mt-2 text-sm text-gray-700 line-clamp-3 whitespace-pre-wrap">{card.finalText}</p>
      )}
      {(card.phase === 'failed' || card.phase === 'budget_exhausted') && card.errorKind && (
        <p className="mt-2 text-sm text-red-600">原因：{card.errorKind}</p>
      )}
      <div className="mt-1 text-xs text-gray-400">最后事件：{card.lastEventType ?? '-'}（seq {card.lastEventSeq}）</div>
    </div>
  );
}
