'use client';
import { useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api';

export default function AdminEvolutionPage() {
  const [stats, setStats] = useState<any>(null);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [signals, setSignals] = useState<any[]>([]);
  const [insights, setInsights] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [budget, setBudget] = useState<any>(null);
  const [tab, setTab] = useState('overview');
  const [candidateFilter, setCandidateFilter] = useState('');
  const [signalFilter, setSignalFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [poolEdit, setPoolEdit] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [s, c, sig, ins, au, b] = await Promise.all([
        apiGet('/evolution/stats').catch(() => null),
        apiGet(`/evolution/candidates${candidateFilter ? `?status=${candidateFilter}` : ''}`).catch(() => ({ candidates: [] })),
        apiGet(`/evolution/signals${signalFilter ? `?type=${signalFilter}` : ''}`).catch(() => ({ signals: [] })),
        apiGet('/evolution/insights').catch(() => ({ insights: [] })),
        apiGet('/evolution/audit').catch(() => ({ audits: [] })),
        apiGet('/evolution/budget').catch(() => null),
      ]);
      setStats(s);
      setCandidates(c.candidates || []);
      setSignals(sig.signals || []);
      setInsights(ins.insights || []);
      setAudit(au.audits || []);
      setBudget(b?.budget || null);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { fetchAll(); }, [candidateFilter, signalFilter]);

  const handleApprove = async (id: string) => { try { await apiPost(`/evolution/candidates/${id}/approve`, {}); fetchAll(); } catch {} };
  const handleReject = async (id: string) => { try { await apiPost(`/evolution/candidates/${id}/reject`, { reason: rejectReason || '管理员拒绝' }); setRejectingId(null); setRejectReason(''); fetchAll(); } catch {} };
  const handlePromoteCanary = async (id: string) => { try { await apiPost(`/evolution/candidates/${id}/promote-canary`, {}); fetchAll(); } catch {} };
  const handleUpdatePool = async () => { try { await apiPut('/evolution/budget', { total: parseInt(poolEdit) }); setPoolEdit(''); fetchAll(); } catch {} };
  const handleDeleteInsight = async (id: string) => { try { await apiDelete(`/evolution/insights/${id}`); fetchAll(); } catch {} };

  if (loading) return <div className="flex justify-center py-20"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>;

  const tabs = [
    { key: 'overview', label: '概览' },
    { key: 'candidates', label: '候选队列' },
    { key: 'signals', label: '信号流' },
    { key: 'insights', label: '地区洞察' },
    { key: 'audit', label: '审计日志' },
  ];

  const statusColors: Record<string, string> = {
    pending: 'bg-warning/20 text-warning',
    promoted: 'bg-success/20 text-success',
    rejected: 'bg-error/20 text-error',
    canary: 'bg-accent/20 text-accent',
    awaiting_approval: 'bg-warning/20 text-warning',
  };

  const scopeColors: Record<string, string> = {
    PERSONAL: 'text-muted',
    SESSION: 'text-accent',
    TEAM: 'text-warning',
    GLOBAL: 'text-error',
  };

  return (
    <div>
      <h1 className="text-2xl font-display font-bold text-primary mb-6 anim-fade-up">进化引擎</h1>

      <div className="flex gap-2 mb-6 flex-wrap anim-fade-up anim-delay-1">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-capsule text-sm transition-colors ${tab === t.key ? 'bg-accent text-on-accent' : 'glass-card-sm text-muted hover:text-primary'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* OVERVIEW */}
      {tab === 'overview' && stats && (
        <div className="space-y-6 anim-fade-up anim-delay-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: '今日信号', value: stats.today.signalCount, color: 'text-accent' },
              { label: '今日候选', value: stats.today.candidateCount, color: 'text-warning' },
              { label: '今日通过', value: stats.today.promoteCount, color: 'text-success' },
              { label: '今日拒绝', value: stats.today.rejectCount, color: 'text-error' },
            ].map(c => (
              <div key={c.label} className="glass-card-sm p-4">
                <div className="text-xs text-muted mb-1">{c.label}</div>
                <div className={`text-2xl font-display font-bold ${c.color}`}>{c.value}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="glass-card-sm p-4">
              <div className="text-xs text-muted mb-1">系统积分池</div>
              <div className="text-lg font-display font-bold text-primary">{stats.today.systemPoolRemaining} / {stats.today.systemPoolTotal}</div>
              <div className="w-full h-1.5 bg-surface rounded-full mt-2">
                <div className="h-full bg-accent rounded-full" style={{ width: `${(stats.today.systemPoolRemaining / stats.today.systemPoolTotal) * 100}%` }} />
              </div>
              <div className="flex gap-2 mt-2">
                <input type="number" value={poolEdit} onChange={e => setPoolEdit(e.target.value)} placeholder="新配额"
                  className="flex-1 bg-bg border border-border rounded px-2 py-1 text-xs text-primary focus:outline-none" />
                <button onClick={handleUpdatePool} disabled={!poolEdit} className="px-2 py-1 bg-accent text-on-accent text-xs rounded disabled:opacity-30">设置</button>
              </div>
            </div>
            <div className="glass-card-sm p-4">
              <div className="text-xs text-muted mb-1">待审批</div>
              <div className="text-lg font-display font-bold text-warning">{stats.pendingApproval}</div>
            </div>
            <div className="glass-card-sm p-4">
              <div className="text-xs text-muted mb-1">Canary 中</div>
              <div className="text-lg font-display font-bold text-accent">{stats.activeCanary}</div>
            </div>
            <div className="glass-card-sm p-4">
              <div className="text-xs text-muted mb-1">地区洞察</div>
              <div className="text-lg font-display font-bold text-primary">{stats.totalInsights}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="glass-card-sm p-4">
              <div className="text-sm font-medium text-primary mb-3">信号类型分布</div>
              {stats.signalBreakdown.map((s: any) => (
                <div key={s.type} className="flex items-center justify-between py-1 text-xs">
                  <span className="text-muted">{s.type}</span>
                  <span className="text-primary font-mono">{s.count}</span>
                </div>
              ))}
            </div>
            <div className="glass-card-sm p-4">
              <div className="text-sm font-medium text-primary mb-3">候选状态分布</div>
              {stats.statusBreakdown.map((s: any) => (
                <div key={s.status} className="flex items-center justify-between py-1 text-xs">
                  <span className={`px-2 py-0.5 rounded ${statusColors[s.status] || 'text-muted'}`}>{s.status}</span>
                  <span className="text-primary font-mono">{s.count}</span>
                </div>
              ))}
            </div>
            <div className="glass-card-sm p-4">
              <div className="text-sm font-medium text-primary mb-3">作用域分布</div>
              {stats.scopeBreakdown.map((s: any) => (
                <div key={s.scope} className="flex items-center justify-between py-1 text-xs">
                  <span className={scopeColors[s.scope] || 'text-muted'}>{s.scope}</span>
                  <span className="text-primary font-mono">{s.count}</span>
                </div>
              ))}
            </div>
          </div>

          {stats.trend.length > 0 && (
            <div className="glass-card-sm p-4">
              <div className="text-sm font-medium text-primary mb-3">30天趋势</div>
              <div className="grid grid-cols-4 sm:grid-cols-7 gap-1">
                {stats.trend.map((t: any, i: number) => {
                  const maxSignals = Math.max(...stats.trend.map((x: any) => x.signals || 1));
                  const height = Math.max(4, (t.signals / maxSignals) * 60);
                  return (
                    <div key={i} className="flex flex-col items-center gap-1">
                      <div className="w-full bg-accent/20 rounded-t" style={{ height: `${height}px` }} title={`信号:${t.signals} 候选:${t.candidates} 通过:${t.promoted}`} />
                      <span className="text-xs text-muted">{new Date(t.date).getDate()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* CANDIDATES */}
      {tab === 'candidates' && (
        <div className="anim-fade-up anim-delay-2">
          <div className="flex gap-2 mb-4 flex-wrap">
            {['', 'pending', 'awaiting_approval', 'canary', 'promoted', 'rejected'].map(s => (
              <button key={s} onClick={() => setCandidateFilter(s)}
                className={`px-3 py-1.5 text-xs rounded-capsule ${candidateFilter === s ? 'bg-accent text-on-accent' : 'glass-card-sm text-muted'}`}>
                {s || '全部'}
              </button>
            ))}
          </div>

          <div className="space-y-3">
            {candidates.length === 0 ? (
              <div className="text-center text-muted py-8 glass-card-sm">暂无候选</div>
            ) : candidates.map((c, i) => (
              <div key={c.id} className="glass-card-sm p-4 anim-fade-up" style={{ animationDelay: `${i * 0.03}s` }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs px-2 py-0.5 rounded ${statusColors[c.status]}`}>{c.status}</span>
                    <span className={`text-xs font-medium ${scopeColors[c.scope]}`}>{c.scope}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-muted">{c.changeType}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-muted">{c.targetType}</span>
                    <span className="text-xs text-muted">Gate {c.gateLevel}</span>
                  </div>
                  <span className="text-xs text-muted">{new Date(c.createdAt).toLocaleString('zh-CN')}</span>
                </div>
                <div className="text-sm text-primary mb-1">{c.hypothesis}</div>
                <div className="text-xs text-muted mb-3 line-clamp-2">{c.content}</div>
                {c.rejectReason && <div className="text-xs text-error mb-2">拒绝原因：{c.rejectReason}</div>}
                <div className="flex gap-2">
                  {c.status === 'awaiting_approval' && (
                    <>
                      <button onClick={() => handleApprove(c.id)} className="px-3 py-1 text-xs bg-success/20 text-success rounded hover:bg-success/30">批准</button>
                      {rejectingId === c.id ? (
                        <div className="flex gap-1">
                          <input value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="原因"
                            className="bg-bg border border-border rounded px-2 py-1 text-xs text-primary focus:outline-none w-40" />
                          <button onClick={() => handleReject(c.id)} className="px-2 py-1 text-xs bg-error/20 text-error rounded">确认</button>
                          <button onClick={() => { setRejectingId(null); setRejectReason(''); }} className="px-2 py-1 text-xs text-muted">取消</button>
                        </div>
                      ) : (
                        <button onClick={() => setRejectingId(c.id)} className="px-3 py-1 text-xs bg-error/20 text-error rounded hover:bg-error/30">拒绝</button>
                      )}
                    </>
                  )}
                  {c.status === 'canary' && (
                    <button onClick={() => handlePromoteCanary(c.id)} className="px-3 py-1 text-xs bg-accent/20 text-accent rounded hover:bg-accent/30">全量发布</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SIGNALS */}
      {tab === 'signals' && (
        <div className="anim-fade-up anim-delay-2">
          <div className="flex gap-2 mb-4 flex-wrap">
            {['', 'user_correction', 'positive_feedback', 'tool_error', 'timeout', 'retry_spike', 'retrieval_miss'].map(s => (
              <button key={s} onClick={() => setSignalFilter(s)}
                className={`px-3 py-1.5 text-xs rounded-capsule ${signalFilter === s ? 'bg-accent text-on-accent' : 'glass-card-sm text-muted'}`}>
                {s || '全部'}
              </button>
            ))}
          </div>
          <div className="space-y-2">
            {signals.length === 0 ? (
              <div className="text-center text-muted py-8 glass-card-sm">暂无信号</div>
            ) : signals.map((s, i) => (
              <div key={s.id} className="glass-card-sm px-4 py-3 flex items-center justify-between anim-fade-up" style={{ animationDelay: `${i * 0.03}s` }}>
                <div>
                  <span className="text-xs font-mono text-accent mr-2">{s.signalType}</span>
                  <span className="text-xs text-muted">{s.detail?.substring(0, 80)}</span>
                  {s.attributed && <span className="text-xs text-success ml-2">已归因</span>}
                  {s.worthEvolving && <span className="text-xs text-warning ml-1">值得进化</span>}
                </div>
                <span className="text-xs text-muted">{new Date(s.createdAt).toLocaleString('zh-CN')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* INSIGHTS */}
      {tab === 'insights' && (
        <div className="anim-fade-up anim-delay-2">
          <div className="space-y-3">
            {insights.length === 0 ? (
              <div className="text-center text-muted py-8 glass-card-sm">暂无地区洞察</div>
            ) : insights.map((ins, i) => (
              <div key={ins.id} className="glass-card-sm p-4 anim-fade-up" style={{ animationDelay: `${i * 0.03}s` }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent">{ins.region}</span>
                    <span className="text-xs text-muted">置信度 {(ins.confidence * 100).toFixed(0)}%</span>
                    <span className="text-xs text-muted">命中 {ins.hitCount} 次</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted">{new Date(ins.createdAt).toLocaleDateString('zh-CN')}</span>
                    <button onClick={() => handleDeleteInsight(ins.id)} className="text-xs text-error hover:text-error/70">删除</button>
                  </div>
                </div>
                <div className="text-sm text-primary">{ins.insight}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AUDIT */}
      {tab === 'audit' && (
        <div className="anim-fade-up anim-delay-2">
          <div className="space-y-1">
            {audit.length === 0 ? (
              <div className="text-center text-muted py-8 glass-card-sm">暂无审计记录</div>
            ) : audit.map((a, i) => (
              <div key={a.id} className="glass-card-sm px-4 py-2 flex items-center justify-between anim-fade-up" style={{ animationDelay: `${i * 0.03}s` }}>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-accent">{a.action}</span>
                  {a.scope && <span className="text-xs text-muted">{a.scope}</span>}
                  {a.reason && <span className="text-xs text-muted truncate max-w-sm">{a.reason}</span>}
                </div>
                <span className="text-xs text-muted">{new Date(a.createdAt).toLocaleString('zh-CN')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}