'use client';
import { useEffect, useState, Fragment } from 'react';
import { apiGet, apiPatch, apiPost, apiDelete } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';

const GENDER_LABEL: Record<string, string> = { male: '男', female: '女' };

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function AdminUsersPage() {
  const { user } = useAuthStore();
  const [users, setUsers] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [creditModal, setCreditModal] = useState<any>(null);
  const [creditAmount, setCreditAmount] = useState('');
  const [creditReason, setCreditReason] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchUsers = async (q = '') => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (q) params.set('search', q);
      const data = await apiGet(`/admin/users?${params}`);
      setUsers(data.users); setTotal(data.total);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { fetchUsers(); }, []);

  const updateField = async (id: string, field: string, value: any) => {
    try {
      await apiPatch(`/admin/users/${id}`, { [field]: value });
      setUsers((u) => u.map((usr) => usr.id === id ? { ...usr, [field]: value } : usr));
    } catch {}
  };

  const toggleDetail = async (id: string) => {
    if (detailId === id) { setDetailId(null); setDetail(null); return; }
    setDetailId(id); setDetail(null); setDetailLoading(true);
    try { setDetail(await apiGet(`/admin/users/${id}/detail`)); } catch {} finally { setDetailLoading(false); }
  };

  const handleAddCredits = async () => {
    if (!creditModal || !creditAmount) return;
    try {
      await apiPost(`/admin/users/${creditModal.id}/credits`, { amount: parseFloat(creditAmount), reason: creditReason });
      setCreditModal(null); setCreditAmount(''); setCreditReason('');
      fetchUsers(search);
    } catch {}
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiDelete(`/admin/users/${deleteTarget.id}`);
      setDeleteTarget(null);
      if (detailId === deleteTarget.id) { setDetailId(null); setDetail(null); }
      fetchUsers(search);
    } catch {} finally { setDeleting(false); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 anim-fade-up">
        <h1 className="text-2xl font-display font-bold text-primary">用户管理</h1>
        <span className="text-sm text-muted">共 {total} 位用户</span>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); fetchUsers(search); }} className="flex gap-2 mb-6 anim-fade-up anim-delay-1">
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索用户名或邮箱..."
          className="flex-1 bg-bg border border-border rounded-card px-4 py-2 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50" />
        <button type="submit" className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium rounded-card transition-colors anim-press">搜索</button>
      </form>

      {loading ? <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div> : (
        <div className="glass-card-sm overflow-hidden anim-fade-up anim-delay-2">
          <div className="overflow-x-auto -mx-px">
            <table className="w-full text-sm min-w-[760px] admin-table">
              <thead><tr className="border-b border-border">
                 {['用户名', '邮箱', '角色', '等级', '积分', '状态', '操作'].map(h => <th key={h} className="text-left px-4 py-3 text-muted font-medium whitespace-nowrap">{h}</th>)}
              </tr></thead>
              <tbody>
                {users.map((u, i) => (
                  <Fragment key={u.id}>
                    <tr className="border-b border-border/50 hover:bg-surface-hover/50 anim-fade-up" style={{ animationDelay: `${i * 0.03}s` }}>
                      <td className="px-4 py-3 text-primary" data-label="用户名">
                        <button onClick={() => toggleDetail(u.id)} className="hover:text-accent transition-colors">
                          {u.username}
                          <span className="ml-1 text-[10px] text-muted">{detailId === u.id ? '▲' : '▼'}</span>
                        </button>
                      </td>
                      <td className="px-4 py-3 text-muted" data-label="邮箱">{u.email}</td>
                      <td className="px-4 py-3" data-label="角色">
                        <select value={u.role} onChange={(e) => updateField(u.id, 'role', e.target.value)} className="bg-bg border border-border rounded px-2 py-1.5 text-xs text-primary focus:outline-none">
                          <option value="USER">用户</option><option value="ADMIN">管理员</option>
                          {user?.role === 'SUPER_ADMIN' && <option value="SUPER_ADMIN">超级管理员</option>}
                        </select>
                      </td>
                      <td className="px-4 py-3" data-label="等级">
                          <select value={u.subscriptionTier} onChange={(e) => updateField(u.id, 'subscriptionTier', e.target.value)} className="bg-bg border border-border rounded px-2 py-1.5 text-xs text-primary focus:outline-none">
                            <option value="STANDARD">免费</option><option value="PRO">Pro</option><option value="ULTRA">Ultra（已停用）</option>
                        </select>
                      </td>
                      <td className="px-4 py-3" data-label="积分">
                        <button onClick={() => setCreditModal(u)} className="text-xs text-accent-figure hover:underline font-mono">{(u.creditBalance || 0).toFixed(1)}</button>
                      </td>
                      <td className="px-4 py-3" data-label="状态"><span className={`text-xs px-2 py-0.5 rounded ${u.isActive ? 'bg-success/20 text-success' : 'bg-error/20 text-error'}`}>{u.isActive ? '正常' : '禁用'}</span></td>
                      <td className="px-4 py-3" data-label="操作">
                        <div className="flex gap-2">
                          <button onClick={() => updateField(u.id, 'isActive', !u.isActive)} className={`text-xs px-3 py-1.5 rounded transition-colors ${u.isActive ? 'bg-error/10 text-error hover:bg-error/20' : 'bg-success/10 text-success hover:bg-success/20'}`}>{u.isActive ? '禁用' : '启用'}</button>
                          <button onClick={() => setDeleteTarget(u)} className="text-xs px-3 py-1.5 rounded bg-error/20 text-error hover:bg-error/30 transition-colors">删除</button>
                        </div>
                      </td>
                    </tr>
                    {detailId === u.id && (
                      <tr className="border-b border-border/50">
                        <td colSpan={7} className="px-4 py-4 bg-surface/30">
                          {detailLoading || !detail ? (
                            <div className="flex justify-center py-4"><div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>
                          ) : (
                            <div className="space-y-4 text-sm">
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                                <div><span className="text-muted">地区：</span><span className="text-primary">{detail.user.region || '—'}</span></div>
                                <div><span className="text-muted">语言：</span><span className="text-primary">{detail.user.language || '—'}</span></div>
                                <div><span className="text-muted">货币：</span><span className="text-primary">{detail.user.currency || '—'}</span></div>
                                <div><span className="text-muted">性别：</span><span className="text-primary">{GENDER_LABEL[detail.user.gender] || detail.user.gender || '未填写'}</span></div>
                                <div><span className="text-muted">会话数：</span><span className="text-primary">{detail.stats.conversationCount}</span></div>
                                <div><span className="text-muted">消息数：</span><span className="text-primary">{detail.stats.messageCount}</span></div>
                                <div><span className="text-muted">被标记对话：</span><span className={detail.stats.flaggedConversationCount > 0 ? 'text-error' : 'text-primary'}>{detail.stats.flaggedConversationCount}</span></div>
                                <div><span className="text-muted">数据量估算：</span><span className="text-primary">≈{formatBytes(detail.stats.estimateBytes)}</span></div>
                              </div>
                              {detail.stats.contentBytes > 0 && (
                                <div className="text-[11px] text-muted">其中消息正文 ≈{formatBytes(detail.stats.contentBytes)}，估算含结构开销</div>
                              )}
                              {detail.orders.length > 0 && (
                                <div>
                                  <div className="text-xs text-muted mb-1.5">支付记录（最近 {detail.orders.length} 条）</div>
                                  <div className="space-y-1">
                                    {detail.orders.map((o: any) => (
                                      <div key={o.id} className="flex items-center gap-3 text-xs rounded bg-bg/50 px-3 py-1.5">
                                        <span className="text-primary font-mono">{o.orderId}</span>
                                        <span className="text-muted">{o.plan}</span>
                                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${o.status === 'PAID' ? 'bg-success/20 text-success' : o.status === 'PENDING' || o.status === 'PROOF_UPLOADED' || o.status === 'AI_REVIEWING' ? 'bg-warning/20 text-warning' : 'bg-error/20 text-error'}`}>{o.status}</span>
                                        <span className="text-muted">${(o.lockedPriceUsd || 0).toFixed(2)}</span>
                                        <span className="text-muted ml-auto">{new Date(o.createdAt).toLocaleDateString()}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {detail.modelUsage.length > 0 && (
                                <div>
                                  <div className="text-xs text-muted mb-1.5">模型使用</div>
                                  <div className="flex flex-wrap gap-2">
                                    {detail.modelUsage.map((m: any) => (
                                      <span key={m.model} className="text-xs rounded bg-bg/50 px-2.5 py-1 text-primary font-mono">
                                        {m.model} · {m._sum.callCount || 0} 次 · {m._sum.tokenCount || 0} tokens
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add credits modal */}
      {creditModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 anim-fade-in" onClick={() => setCreditModal(null)}>
          <div className="liquid-glass p-6 w-80 anim-scale-in" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-display font-semibold text-primary mb-4">添加积分 — {creditModal.username}</h3>
            <div className="mb-3">
              <label className="block text-sm text-muted mb-1">积分数量</label>
              <input type="number" value={creditAmount} onChange={(e) => setCreditAmount(e.target.value)} placeholder="100"
                className="w-full bg-bg border border-border rounded-card px-4 py-2 text-sm text-primary focus:outline-none focus:border-accent/50" />
            </div>
            <div className="mb-4">
              <label className="block text-sm text-muted mb-1">原因</label>
              <input type="text" value={creditReason} onChange={(e) => setCreditReason(e.target.value)} placeholder="补偿/奖励"
                className="w-full bg-bg border border-border rounded-card px-4 py-2 text-sm text-primary focus:outline-none focus:border-accent/50" />
            </div>
            <div className="flex gap-2">
              <button onClick={handleAddCredits} className="flex-1 py-2 bg-accent text-on-accent rounded-card anim-hover-scale">添加</button>
              <button onClick={() => setCreditModal(null)} className="flex-1 py-2 bg-surface-hover text-muted rounded-card">取消</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 anim-fade-in" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="liquid-glass p-6 w-96 anim-scale-in" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-display font-semibold text-error mb-3">删除用户</h3>
            <p className="text-sm text-muted mb-4">
              将 <span className="text-error font-medium">永久删除</span> 用户 <span className="text-primary">{deleteTarget.username}</span>（{deleteTarget.email}），
              包括其全部会话、消息、积分与订阅数据。此操作不可恢复。
            </p>
            <div className="flex gap-2">
              <button onClick={handleDelete} disabled={deleting}
                className={`flex-1 py-2 rounded-card text-sm font-medium transition-colors ${deleting ? 'bg-surface-hover text-muted' : 'bg-error text-on-accent anim-press'}`}>
                {deleting ? '删除中...' : '确认删除'}
              </button>
              <button onClick={() => setDeleteTarget(null)} disabled={deleting} className="flex-1 py-2 bg-surface-hover text-muted rounded-card">取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
