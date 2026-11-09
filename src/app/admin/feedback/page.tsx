'use client';
import { useEffect, useState } from 'react';
import { apiGet, apiPatch } from '@/lib/api';

export default function AdminFeedbackPage() {
  const [feedbacks, setFeedbacks] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<any>(null);
  const [reply, setReply] = useState('');
  const [updating, setUpdating] = useState(false);

  const fetchFeedbacks = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      const data = await apiGet(`/feedback/admin?${params}`);
      setFeedbacks(data.feedbacks);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { fetchFeedbacks(); }, [status]);

  const handleUpdateStatus = async (id: string, newStatus: string) => {
    try {
      await apiPatch(`/feedback/admin/${id}`, { status: newStatus });
      fetchFeedbacks();
      if (selected?.id === id) setSelected((s: any) => s ? { ...s, status: newStatus } : null);
    } catch {}
  };

  const handleReply = async () => {
    if (!selected || !reply.trim()) return;
    setUpdating(true);
    try {
      await apiPatch(`/feedback/admin/${selected.id}`, { reply, status: 'resolved' });
      setReply(''); setSelected(null); fetchFeedbacks();
    } catch {} finally { setUpdating(false); }
  };

  const typeLabels: Record<string, string> = { bug: 'Bug', feature: '建议', other: '其他' };
  const statusLabels: Record<string, string> = { pending: '待处理', processing: '处理中', resolved: '已解决' };
  const statusColors: Record<string, string> = { pending: 'bg-warning/20 text-warning', processing: 'bg-accent/20 text-accent', resolved: 'bg-success/20 text-success' };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 anim-fade-up">
        <h1 className="text-2xl font-display font-bold text-primary">问题反馈</h1>
        <span className="text-sm text-muted">共 {feedbacks.length} 条</span>
      </div>

      <div className="flex gap-2 mb-4 anim-fade-up anim-delay-1">
        {['', 'pending', 'processing', 'resolved'].map(s => (
          <button key={s} onClick={() => setStatus(s)}
            className={`px-3 py-1.5 text-xs rounded-capsule transition-colors ${status === s ? 'bg-accent text-on-accent' : 'glass-card-sm text-muted hover:text-primary'}`}>
            {s ? statusLabels[s] : '全部'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-3">
            {feedbacks.length === 0 ? (
              <div className="text-center text-muted py-8 glass-card-sm">暂无反馈</div>
            ) : feedbacks.map((fb, i) => (
              <div key={fb.id} onClick={() => { setSelected(fb); setReply(fb.reply || ''); }}
                className={`glass-card-sm p-4 cursor-pointer transition-[background-color,border-color,box-shadow,opacity,transform,color] anim-fade-up ${selected?.id === fb.id ? 'ring-2 ring-accent/50' : 'hover:bg-surface-hover/50'}`}
                style={{ animationDelay: `${i * 0.03}s` }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-primary">{fb.user?.username || 'Unknown'}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-muted">{typeLabels[fb.type]}</span>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded ${statusColors[fb.status]}`}>{statusLabels[fb.status]}</span>
                </div>
                <div className="text-sm text-primary mb-1">{fb.title}</div>
                <div className="text-xs text-muted line-clamp-2">{fb.content}</div>
                <div className="text-xs text-muted mt-1">{new Date(fb.createdAt).toLocaleString('zh-CN')}</div>
              </div>
            ))}
          </div>

          {selected && (
            <div className="glass-card-sm p-5 sticky top-0 anim-scale-in">
              <div className="flex items-center justify-between mb-3">
                <span className="text-lg font-display font-semibold text-primary">{selected.title}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${statusColors[selected.status]}`}>{statusLabels[selected.status]}</span>
              </div>
              <div className="text-xs text-muted mb-3">来自 {selected.user?.username} · {new Date(selected.createdAt).toLocaleString('zh-CN')}</div>
              <div className="text-sm text-primary mb-4 whitespace-pre-wrap max-h-40 overflow-y-auto">{selected.content}</div>

              {selected.attachments && selected.attachments.length > 0 && (
                <div className="mb-4">
                  <div className="text-xs text-muted mb-2">附件：</div>
                  <div className="flex flex-wrap gap-2">
                    {selected.attachments.map((att: any, j: number) => (
                      att.type === 'image' ? (
                        <a key={j} href={att.data} target="_blank" rel="noopener noreferrer">
                          <img src={att.data} alt={att.name} className="w-24 h-24 object-cover rounded-card border border-border hover:ring-2 hover:ring-accent/50 transition-[background-color,border-color,box-shadow,opacity,transform,color]" />
                        </a>
                      ) : (
                        <video key={j} src={att.data} controls className="w-48 rounded-card border border-border" />
                      )
                    ))}
                  </div>
                </div>
              )}

              <div className="border-t border-border pt-4">
                <div className="text-xs text-muted mb-2">回复：</div>
                <textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="输入回复内容..."
                  className="w-full bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50 h-20 resize-none mb-3" />
                <div className="flex gap-2">
                  <button onClick={handleReply} disabled={!reply.trim() || updating}
                    className="flex-1 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm rounded-card disabled:opacity-30 anim-hover-scale">
                    {updating ? '提交中...' : '回复并解决'}
                  </button>
                  <select value={selected.status} onChange={(e) => handleUpdateStatus(selected.id, e.target.value)}
                    className="bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary focus:outline-none">
                    <option value="pending">待处理</option>
                    <option value="processing">处理中</option>
                    <option value="resolved">已解决</option>
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}