'use client';
import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';

export default function AdminPaymentsPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<any>(null);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionReason, setActionReason] = useState('');

  const fetchOrders = async () => {
    setLoading(true);
    try {
      const url = filter ? `/payment/admin/orders?status=${filter}` : '/payment/admin/orders';
      const data = await apiGet(url);
      setOrders(data.orders || []);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { fetchOrders(); }, [filter]);

  const handleViewAudit = async (orderId: string) => {
    try {
      const data = await apiGet(`/payment/admin/orders/${orderId}/audit`);
      setAuditLogs(data.logs || []);
      setSelectedOrder(orders.find(o => o.orderId === orderId) || null);
    } catch {}
  };

  const handleApprove = async (orderId: string) => {
    try {
      await apiPost(`/payment/admin/orders/${orderId}/approve`, { reason: actionReason || '人工审核通过' });
      setActionReason('');
      fetchOrders();
    } catch {}
  };

  const handleReject = async (orderId: string) => {
    try {
      await apiPost(`/payment/admin/orders/${orderId}/reject`, { reason: actionReason || '审核不通过' });
      setActionReason('');
      fetchOrders();
    } catch {}
  };

  const statusColors: Record<string, string> = {
    AWAITING_PAYMENT: 'text-muted', PROOF_UPLOADED: 'text-accent', AI_REVIEWING: 'text-accent',
    PASS: 'text-success', UNDERPAID: 'text-warning', OVERPAID: 'text-warning',
    INVALID: 'text-error', SUSPECTED_TAMPERING: 'text-error', PAID: 'text-success',
    EXPIRED: 'text-muted', CANCELLED: 'text-muted',
  };

  return (
    <div>
      <h1 className="text-2xl font-display font-bold text-primary mb-6 anim-fade-up">付款审核</h1>

      <div className="flex gap-2 mb-6 flex-wrap anim-fade-up anim-delay-1">
        {['', 'AWAITING_PAYMENT', 'AI_REVIEWING', 'UNDERPAID', 'INVALID', 'SUSPECTED_TAMPERING', 'PAID'].map(s => (
          <button key={s} onClick={() => setFilter(s)}
            className={`px-3 py-1.5 text-xs rounded-capsule ${filter === s ? 'bg-accent text-on-accent' : 'liquid-glass text-muted hover:text-primary'}`}>
            {s || '全部'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>
      ) : (
        <div className="space-y-3 anim-fade-up anim-delay-2">
          {orders.length === 0 ? (
            <div className="text-center text-muted py-8 liquid-glass">暂无订单</div>
          ) : orders.map((o, i) => (
            <div key={o.orderId} className="liquid-glass p-4 anim-fade-up" style={{ animationDelay: `${i * 0.03}s` }}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono text-accent">{o.orderId}</span>
                  <span className={`text-xs font-medium ${statusColors[o.status] || 'text-muted'}`}>{o.status}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-muted">{o.paymentMethod?.toUpperCase()}</span>
                  <span className="text-xs text-muted">{o.user?.username}</span>
                </div>
                <span className="text-xs text-muted">{new Date(o.createdAt).toLocaleString('zh-CN')}</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 text-xs mb-3">
                <div><span className="text-muted">期望:</span> <span className="text-primary">{o.expectedAmount} {o.currency}</span></div>
                <div><span className="text-muted">已验证:</span> <span className="text-success">{o.verifiedTotal}</span></div>
                <div><span className="text-muted">剩余:</span> <span className={o.remainingAmount > 0 ? 'text-warning' : 'text-success'}>{o.remainingAmount}</span></div>
                <div><span className="text-muted">交易数:</span> <span className="text-primary">{o.transactions?.length || 0}</span></div>
              </div>

              {o.reviews?.[0] && (
                <div className="text-xs text-muted mb-3">
                  最新审核: <span className={statusColors[o.reviews[0].decision] || ''}>{o.reviews[0].decision}</span>
                  {o.reviews[0].reason && ` — ${o.reviews[0].reason}`}
                </div>
              )}

              <div className="flex gap-2 flex-wrap">
                <button onClick={() => handleViewAudit(o.orderId)} className="px-3 py-1 text-xs liquid-glass rounded-capsule text-muted hover:text-primary">审计日志</button>
                {o.status !== 'PAID' && o.status !== 'CANCELLED' && (
                  <>
                    <input value={actionReason} onChange={e => setActionReason(e.target.value)} placeholder="原因"
                      className="bg-bg border border-border rounded px-2 py-1 text-xs text-primary focus:outline-none w-32" />
                    <button onClick={() => handleApprove(o.orderId)} className="px-3 py-1 text-xs bg-success/20 text-success rounded-capsule hover:bg-success/30">批准</button>
                    <button onClick={() => handleReject(o.orderId)} className="px-3 py-1 text-xs bg-error/20 text-error rounded-capsule hover:bg-error/30">拒绝</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Audit Log Modal */}
      {selectedOrder && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setSelectedOrder(null)}>
          <div className="liquid-glass-strong p-6 max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-display font-bold text-primary">审计日志</h2>
              <button onClick={() => setSelectedOrder(null)} className="text-muted hover:text-primary">✕</button>
            </div>
            <div className="text-xs text-muted mb-4">
              订单: {selectedOrder.orderId} | {selectedOrder.paymentMethod?.toUpperCase()} | {selectedOrder.expectedAmount} {selectedOrder.currency}
            </div>
            <div className="space-y-2">
              {auditLogs.length === 0 ? (
                <div className="text-center text-muted py-4">无日志</div>
              ) : auditLogs.map((log, i) => (
                <div key={log.id} className="flex items-start gap-3 text-xs">
                  <span className="text-muted whitespace-nowrap">{new Date(log.createdAt).toLocaleTimeString('zh-CN')}</span>
                  <span className="text-accent font-mono">{log.action}</span>
                  <span className="text-muted flex-1">{log.detail}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}