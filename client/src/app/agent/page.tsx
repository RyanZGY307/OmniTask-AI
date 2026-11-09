'use client';
// Agent 任务列表页（S5）：数据源 = GET /agent/runs（服务端用事件流投影成卡片 VM）。
// 前端不另存任务状态；轮询刷新即可（5s），详情页走 SSE 实时流。
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPost } from '@/lib/api';
import TaskCard from '@/components/agent/TaskCard';
import CapabilityPanel from '@/components/agent/CapabilityPanel';
import type { AgentCapabilities, AgentRunRow, TaskCardVM } from '@/lib/agentTypes';

interface ListResp {
  runs: AgentRunRow[];
  cards: { runId: string; card: TaskCardVM }[];
  running: string[];
}

export default function AgentTasksPage() {
  const [data, setData] = useState<ListResp | null>(null);
  const [caps, setCaps] = useState<AgentCapabilities | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, cap] = await Promise.all([
        apiGet('/agent/runs?limit=50'),
        apiGet('/agent/capabilities').catch(() => null),
      ]);
      setData(list);
      if (cap?.capabilities) setCaps(cap.capabilities);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function createAndStart() {
    if (!objective.trim() || busy) return;
    setBusy(true);
    try {
      const { runId } = await apiPost('/agent/runs', {
        objective: objective.trim(),
        userMessage: objective.trim(),
      });
      window.location.href = `/agent/runs/${runId}`;
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const cardOf = (runId: string) => data?.cards.find((c) => c.runId === runId)?.card;

  return (
    <main className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-xl font-semibold text-gray-900">Agent 任务</h1>

      <CapabilityPanel caps={caps} />

      <div className="border rounded-lg p-3 bg-white shadow-sm flex gap-2">
        <input
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="输入任务目标，回车创建并启动 run…"
          className="flex-1 border rounded px-3 py-2 text-sm"
          onKeyDown={(e) => { if (e.key === 'Enter') createAndStart(); }}
        />
        <button
          disabled={busy || !objective.trim()}
          onClick={createAndStart}
          className="px-4 py-2 rounded bg-blue-600 text-white text-sm disabled:opacity-50"
        >
          创建并启动
        </button>
      </div>

      {err && <p className="text-sm text-red-600">加载失败：{err}</p>}

      <div className="space-y-3">
        {data?.runs.length ? (
          data.runs.map((r) => {
            const card = cardOf(r.id);
            return (
              <Link key={r.id} href={`/agent/runs/${r.id}`} className="block hover:opacity-90">
                {card ? (
                  <TaskCard card={card} running={data.running.includes(r.id)} />
                ) : (
                  <div className="border rounded-lg p-3 bg-white text-sm text-gray-500">
                    {r.id}（{r.state}）
                  </div>
                )}
              </Link>
            );
          })
        ) : (
          !err && <p className="text-sm text-gray-400">还没有 run。先在上方创建一个任务。</p>
        )}
      </div>
    </main>
  );
}
