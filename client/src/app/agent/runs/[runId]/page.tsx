'use client';
// Agent run 详情页（S5）：初始数据来自 GET /agent/runs/:runId（服务端投影），
// 之后订阅 /agent/events/:runId/stream（agent_event 帧族），收到新事件后重新拉详情 ——
// 卡片相位的翻转完全由事件驱动（TaskPhase 11 态），前端不本地推断。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { apiGet, getApiUrl } from '@/lib/api';
import TaskCard from '@/components/agent/TaskCard';
import TaskEventList from '@/components/agent/TaskEventList';
import ApprovalCard from '@/components/agent/ApprovalCard';
import type { AgentRunRow, PendingApprovalVM, TaskCardVM, TaskEventRowVM } from '@/lib/agentTypes';

interface DetailResp {
  run: AgentRunRow;
  card: TaskCardVM;
  eventRows: TaskEventRowVM[];
  pendingApprovals: PendingApprovalVM[];
  running: boolean;
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('cortex_token');
}

export default function AgentRunDetailPage() {
  const params = useParams<{ runId: string }>();
  const runId = params?.runId ?? '';
  const [detail, setDetail] = useState<DetailResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [liveSeq, setLiveSeq] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!runId) return;
    try {
      const d = await apiGet(`/agent/runs/${runId}`);
      setDetail(d);
      setLiveSeq(d.card.lastEventSeq);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }, [runId]);

  useEffect(() => {
    load();
    // SSE 流：fetch + reader（Bearer 头），解析 data: 行中的 agent_event 帧
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    (async () => {
      try {
        const token = getToken();
        const res = await fetch(`${getApiUrl()}/agent/events/${runId}/stream`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: ctrl.signal,
        });
        if (!res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = frame.startsWith('data:') ? frame.slice(5).trim() : '';
            if (!line) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.type === 'agent_event') {
                setLiveSeq((s) => Math.max(s, msg.seq ?? s));
                load(); // 新事件 → 重拉详情（服务端重新投影，UI 无本地状态）
              }
            } catch { /* 忽略非 JSON 帧 */ }
          }
        }
      } catch { /* 连接结束或中断 */ }
    })();
    return () => ctrl.abort();
  }, [runId, load]);

  if (err && !detail) return <main className="max-w-3xl mx-auto p-6 text-red-600">加载失败：{err}</main>;
  if (!detail) return <main className="max-w-3xl mx-auto p-6 text-gray-400">加载中…</main>;

  const { card, eventRows, pendingApprovals } = detail;

  return (
    <main className="max-w-3xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Run 详情</h1>
        <span className="text-xs text-gray-400">实时水位 seq={liveSeq}</span>
      </div>

      <TaskCard card={card} running={detail.running} />

      {card.phase === 'waiting_approval' && pendingApprovals.length > 0 && (
        <div className="space-y-2">
          {pendingApprovals.filter((a) => a.state === 'pending').map((a) => (
            <ApprovalCard key={a.id} approval={a} onDecided={load} />
          ))}
        </div>
      )}

      <section>
        <h2 className="text-sm font-medium text-gray-700 mb-2">事件时间线</h2>
        <TaskEventList rows={eventRows} />
      </section>
    </main>
  );
}
