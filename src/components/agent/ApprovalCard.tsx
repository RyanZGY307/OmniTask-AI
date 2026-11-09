'use client';
// 审批卡：对应 approval.requested 事件。决定按钮调用 POST /agent/approvals/:id/decide，
// by = 当前登录用户（服务端取自 token，红线：人类身份）。卡片文案来自事件 payload.summary（服务端投影透传）。
import { useState } from 'react';
import { apiPost } from '@/lib/api';
import type { PendingApprovalVM } from '@/lib/agentTypes';

export default function ApprovalCard({ approval, onDecided }: { approval: PendingApprovalVM; onDecided?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function decide(decision: 'approved' | 'denied') {
    if (busy) return;
    setBusy(true);
    try {
      await apiPost(`/agent/approvals/${approval.id}/decide`, { decision });
      setDone(decision === 'approved' ? '已批准，继续执行' : '已拒绝');
      onDecided?.();
    } catch (e: any) {
      setDone(`操作失败：${e?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="border border-amber-300 bg-amber-50 rounded-lg p-3 text-sm text-amber-800">
        审批{approval.riskLevel.toUpperCase()} · {done}
      </div>
    );
  }
  return (
    <div className="border border-amber-400 bg-amber-50 rounded-lg p-3">
      <div className="text-sm font-medium text-amber-900">
        待审批（{approval.riskLevel.toUpperCase()}）
      </div>
      <p className="mt-1 text-sm text-gray-800 whitespace-pre-wrap">{approval.summary}</p>
      <div className="mt-2 flex gap-2">
        <button
          disabled={busy}
          onClick={() => decide('approved')}
          className="px-3 py-1 rounded bg-green-600 text-white text-sm disabled:opacity-50"
        >
          批准
        </button>
        <button
          disabled={busy}
          onClick={() => decide('denied')}
          className="px-3 py-1 rounded bg-red-600 text-white text-sm disabled:opacity-50"
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
