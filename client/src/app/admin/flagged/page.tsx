'use client';
import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';

const LEVEL_META: Record<string, { label: string; cls: string }> = {
  high: { label: '高敏感·直接拒绝', cls: 'bg-error/20 text-error border-error/40' },
  medium: { label: '中敏感·警告后拒绝', cls: 'bg-warning/20 text-warning border-warning/40' },
};

// 落档提交状态：pending 写入中 / ok 已提交 / failed 提交失败（拒绝本身仍生效）
const UPLOAD_META: Record<string, { label: string; cls: string }> = {
  ok: { label: '已提交', cls: 'bg-success/15 text-success border-success/30' },
  pending: { label: '提交中', cls: 'bg-warning/15 text-warning border-warning/30' },
  failed: { label: '提交失败', cls: 'bg-error/15 text-error border-error/30' },
};

export default function AdminFlaggedPage() {
  const [flagged, setFlagged] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [levelFilter, setLevelFilter] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchFlagged = async (level = '') => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (level) params.set('level', level);
      const data = await apiGet(`/admin/flagged?${params}`);
      setFlagged(data.flagged); setTotal(data.total);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { fetchFlagged(); }, []);

  const toggleDetail = async (id: string) => {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id); setDetail(null); setDetailLoading(true);
    try { setDetail(await apiGet(`/admin/flagged/${id}`)); } catch {} finally { setDetailLoading(false); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 anim-fade-up">
        <h1 className="text-2xl font-display font-bold text-primary">标记对话</h1>
        <div className="flex items-center gap-3">
          <select value={levelFilter} onChange={(e) => { setLevelFilter(e.target.value); fetchFlagged(e.target.value); }}
            className="bg-bg border border-border rounded px-3 py-1.5 text-xs text-primary focus:outline-none">
            <option value="">全部等级</option>
            <option value="high">高敏感（直接拒绝）</option>
            <option value="medium">高敏感（警告后拒绝）</option>
          </select>
          <span className="text-sm text-muted">共 {total} 条</span>
        </div>
      </div>

      {loading ? <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div> : flagged.length === 0 ? (
        <div className="glass-card-sm p-12 text-center text-muted text-sm anim-fade-up">暂无被标记的对话</div>
      ) : (
        <div className="space-y-3">
          {flagged.map((f, i) => (
            <div key={f.id} className="glass-card-sm anim-fade-up anim-delay-1 overflow-hidden" style={{ animationDelay: `${Math.min(i, 8) * 0.04}s` }}>
              <button onClick={() => toggleDetail(f.id)} className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-surface-hover/50 transition-colors">
                <span className={`text-xs px-2 py-0.5 rounded border whitespace-nowrap ${LEVEL_META[f.level]?.cls || 'bg-surface text-muted border-border'}`}>
                  {LEVEL_META[f.level]?.label || f.level}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-primary truncate">{f.username || f.userId}</div>
                  <div className="text-xs text-muted truncate">{f.reason || '—'}</div>
                </div>
                <div className="text-right text-xs text-muted whitespace-nowrap">
                  <div>{new Date(f.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                  <div>警告 {f.warningCount} 次 · 上传 {f.uploadedPairs} 对</div>
                  {f.uploadStatus && f.uploadStatus !== 'ok' && (
                    <div className={(UPLOAD_META[f.uploadStatus] || UPLOAD_META.pending).cls.split(' ').find((c) => c.startsWith('text-')) || 'text-muted'}>
                      {(UPLOAD_META[f.uploadStatus] || UPLOAD_META.pending).label}
                    </div>
                  )}
                </div>
                <span className="text-muted text-xs">{openId === f.id ? '▲' : '▼'}</span>
              </button>
              {openId === f.id && (
                <div className="border-t border-border/50 px-4 py-4 bg-surface/30">
                  {detailLoading || !detail ? (
                    <div className="flex justify-center py-4"><div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>
                  ) : (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <div><span className="text-muted">用户名：</span><span className="text-primary">{detail.flag.username || '—'}</span></div>
                        <div><span className="text-muted">邮箱：</span><span className="text-primary">{detail.flag.userEmail || '—'}</span></div>
                        <div><span className="text-muted">模型：</span><span className="text-primary font-mono">{detail.flag.model || '—'}</span></div>
                        <div><span className="text-muted">会话：</span><span className="text-primary font-mono">{detail.flag.conversationId}</span></div>
                      </div>
                      {detail.flag.reason && <div className="text-xs text-muted">命中标签：{detail.flag.reason}</div>}
                      <div className="border border-error/30 rounded-lg bg-error/5">
                        <div className="px-3 py-2 text-xs text-error border-b border-error/20 flex items-center justify-between">
                          <span>快照 · 上溯 {detail.flag.uploadedPairs} 对消息（共 {detail.messages.length} 条）</span>
                        </div>
                        <div className="max-h-96 overflow-y-auto p-3 space-y-2">
                          {detail.messages.map((m: any, idx: number) => {
                            const isUser = m.role === 'user';
                            return (
                              // 与主对话同一套规则：无头像、AI 输出无框、用户气泡反色、
                              // 所有字与所在背景相反。这里底色不是页背景而是 bg-error/5，
                              // --accent / --text-primary 在它之上对比度仍然足够。
                              <div key={idx} className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                                {/* 标签在气泡之外、落在 bg-error/5 上，必须用 text-primary
                                    反色；气泡内部的 chat-meta-user 只对 --accent 底成立，
                                    直接搬过来在白底上会隐形。 */}
                                <div className="text-[10px] chat-meta-model mb-0.5 px-1">{isUser ? '用户' : 'AI'}</div>
                                <div className={`text-xs max-w-[88%] ${isUser ? 'chat-user-bubble' : 'chat-model-text'}`}>
                                  <div className="whitespace-pre-wrap break-words line-clamp-6">{m.content}</div>
                                </div>
                              </div>
                            );
                          })}
                          {detail.messages.length === 0 && <div className="text-xs text-muted text-center py-4">无快照内容</div>}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
