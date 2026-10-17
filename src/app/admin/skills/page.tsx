'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiDelete } from '@/lib/api';

type Tab = 'catalog' | 'roster';

function StatusBadge({ s }: { s: string }) {
  const map: Record<string, string> = {
    active: 'bg-success/20 text-success',
    pending: 'bg-warning/20 text-warning',
    rejected: 'bg-error/20 text-error',
    promoted: 'bg-accent/20 text-accent',
  };
  const label: Record<string, string> = { active: '已启用', pending: '待审核', rejected: '已拒绝', promoted: '已提升' };
  return <span className={`text-xs px-1.5 py-0.5 rounded ${map[s] || 'bg-surface-hover text-muted'}`}>{label[s] || s}</span>;
}

export default function AdminSkillsPage() {
  const [tab, setTab] = useState<Tab>('catalog');

  // ---- Global catalog (existing CRUD) ----
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', prompt: '', category: '' });

  // ---- Install roster (cross-account) ----
  const [roster, setRoster] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [filters, setFilters] = useState<{ status: string; scanStatus: string; search: string }>({ status: '', scanStatus: '', search: '' });
  const [busy, setBusy] = useState<string | null>(null);

  const fetchSkills = async () => { setLoading(true); try { const data = await apiGet('/admin/skills'); setSkills(data.skills); } catch {} finally { setLoading(false); } };
  const fetchRoster = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      if (filters.status) q.set('status', filters.status);
      if (filters.scanStatus) q.set('scanStatus', filters.scanStatus);
      if (filters.search) q.set('search', filters.search);
      const data = await apiGet(`/admin/skills/roster?${q.toString()}`);
      setRoster(data.roster || []);
      setSummary(data.summary || null);
    } catch {}
  }, [filters]);

  useEffect(() => { fetchSkills(); }, []);
  useEffect(() => { fetchRoster(); }, [fetchRoster]);

  const handleAdd = async () => { try { await apiPost('/admin/skills', form); setForm({ name: '', description: '', prompt: '', category: '' }); setShowAdd(false); fetchSkills(); } catch {} };
  const handleDelete = async (id: string) => { if (!confirm('确定删除？')) return; try { await apiDelete(`/admin/skills/${id}`); fetchSkills(); } catch {} };

  const promote = async (id: string) => {
    if (!confirm('将此账号级技能提升到全局技能池？所有账号将可见。')) return;
    setBusy(id);
    try {
      const r = await apiPost(`/admin/skills/roster/${id}/promote`, {});
      fetchRoster();
      if (!r.analysisEnqueued) alert('已提升，但 S1 分析入队失败（不影响提升）。');
    } catch {} finally { setBusy(null); }
  };

  const reject = async (id: string) => {
    const reason = prompt('拒绝原因（可选，将记录在案）：') || '';
    setBusy(id);
    try { await apiPost(`/admin/skills/roster/${id}/reject`, { reason }); fetchRoster(); } catch {} finally { setBusy(null); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4 anim-fade-up">
        <h1 className="text-2xl font-display font-bold text-primary">Skill 管理</h1>
        <div className="flex gap-2">
          <button onClick={() => setTab('catalog')} className={`px-3 py-1.5 text-sm rounded-card ${tab === 'catalog' ? 'bg-accent text-on-accent' : 'bg-surface-hover text-muted'}`}>全局目录</button>
          <button onClick={() => setTab('roster')} className={`px-3 py-1.5 text-sm rounded-card ${tab === 'roster' ? 'bg-accent text-on-accent' : 'bg-surface-hover text-muted'}`}>全量安装</button>
        </div>
      </div>

      {tab === 'catalog' ? (
        <>
          <div className="mb-4">
            <button onClick={() => setShowAdd(!showAdd)} className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm rounded-card anim-press">+ 添加 Skill</button>
          </div>
          {showAdd && (
            <div className="glass-card-sm p-5 mb-6 anim-scale-in">
              <div className="grid grid-cols-2 gap-3 mb-3">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="名称" className="bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary focus:outline-none" />
                <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="分类" className="bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary focus:outline-none" />
              </div>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="描述" className="w-full bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary focus:outline-none mb-3" />
              <textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="System Prompt..." className="w-full bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary focus:outline-none mb-3 h-32 resize-none font-mono" />
              <div className="flex gap-2">
                <button onClick={handleAdd} className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm rounded-card anim-press">保存</button>
                <button onClick={() => setShowAdd(false)} className="px-4 py-2 bg-surface-hover text-muted text-sm rounded-card">取消</button>
              </div>
            </div>
          )}
          {loading ? <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div> : (
            <div className="space-y-2">
              {skills.length === 0 ? <div className="text-center text-muted py-8 glass-card-sm anim-fade-up">暂无 Skill</div> : skills.map((skill, i) => (
                <div key={skill.id} className="glass-card-sm p-4 anim-fade-up" style={{ animationDelay: `${i * 0.03}s` }}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-primary">{skill.name}</span>
                      {skill.category && <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-muted">{skill.category}</span>}
                      <span className={`text-xs px-1.5 py-0.5 rounded ${skill.isActive ? 'bg-success/20 text-success' : 'bg-error/20 text-error'}`}>{skill.isActive ? '启用' : '禁用'}</span>
                    </div>
                    <button onClick={() => handleDelete(skill.id)} className="text-xs text-error hover:text-error/70 px-2 py-1">删除</button>
                  </div>
                  {skill.description && <p className="text-xs text-muted mb-2">{skill.description}</p>}
                  <pre className="text-xs text-muted bg-bg rounded p-2 overflow-x-auto max-h-20">{skill.prompt?.substring(0, 200)}...</pre>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {summary && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
              {[['pending', summary.statusCounts?.pending], ['active', summary.statusCounts?.active], ['rejected', summary.statusCounts?.rejected], ['promoted', summary.statusCounts?.promoted], ['flagged', summary.flagged]].map(([k, v]: any) => (
                <div key={k} className="glass-card-sm p-3 text-center">
                  <div className="text-lg font-display font-bold text-primary">{v ?? 0}</div>
                  <div className="text-xs text-muted uppercase">{k}</div>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2 mb-4 flex-wrap">
            <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} className="bg-bg border border-border rounded-card px-2 py-1.5 text-sm text-primary focus:outline-none">
              <option value="">全部状态</option>
              <option value="pending">待审核</option>
              <option value="active">已启用</option>
              <option value="rejected">已拒绝</option>
              <option value="promoted">已提升</option>
            </select>
            <select value={filters.scanStatus} onChange={(e) => setFilters({ ...filters, scanStatus: e.target.value })} className="bg-bg border border-border rounded-card px-2 py-1.5 text-sm text-primary focus:outline-none">
              <option value="">全部扫描</option>
              <option value="clean">通过</option>
              <option value="flagged">标记</option>
            </select>
            <input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="按名称搜索" className="flex-1 min-w-[120px] bg-bg border border-border rounded-card px-3 py-1.5 text-sm text-primary focus:outline-none" />
          </div>

          <div className="space-y-2">
            {roster.length === 0 ? <div className="text-center text-muted py-8 glass-card-sm anim-fade-up">暂无安装记录</div> : roster.map((row, i) => {
              const s = row.skill;
              const capCount = row.capabilities?.length || 0;
              return (
                <div key={s.id} className="glass-card-sm p-4 anim-fade-up" style={{ animationDelay: `${i * 0.02}s` }}>
                  <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-primary">{s.name}</span>
                      <StatusBadge s={s.status} />
                      <span className={`text-xs px-1.5 py-0.5 rounded ${s.scanStatus === 'clean' ? 'bg-success/15 text-success' : s.scanStatus === 'flagged' ? 'bg-error/15 text-error' : 'bg-surface-hover text-muted'}`}>{s.scanStatus === 'clean' ? '扫描通过' : s.scanStatus === 'flagged' ? '已标记' : '未扫描'}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-muted uppercase">{s.sourceType}</span>
                      {capCount > 0 && <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-muted">{capCount} 能力</span>}
                    </div>
                    <div className="flex gap-1">
                      {s.status !== 'promoted' && s.status !== 'rejected' && (
                        <button onClick={() => promote(s.id)} disabled={busy === s.id} className="text-xs px-2 py-1 bg-accent/20 text-accent hover:bg-accent/30 rounded disabled:opacity-50">{busy === s.id ? '…' : '提升到全局'}</button>
                      )}
                      {s.status !== 'rejected' && (
                        <button onClick={() => reject(s.id)} disabled={busy === s.id} className="text-xs px-2 py-1 bg-error/15 text-error hover:bg-error/25 rounded disabled:opacity-50">拒绝</button>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-muted mb-1">
                    账号：{row.owner ? <span>{row.owner.username} · {row.owner.email}</span> : <span className="opacity-60">未知</span>}
                    {s.repoName && <span> · {s.repoOwner}/{s.repoName}{s.repoRef ? ` @ ${s.repoRef}` : ''}</span>}
                  </div>
                  <pre className="text-xs text-muted bg-bg rounded p-2 overflow-x-auto max-h-20 whitespace-pre-wrap">{(s.prompt || '').substring(0, 240)}{String(s.prompt || '').length > 240 ? '…' : ''}</pre>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
