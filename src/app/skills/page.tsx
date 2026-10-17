'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost, apiDelete } from '@/lib/api';

type Skill = any;

function statusBadge(s: string) {
  const map: Record<string, string> = {
    active: 'bg-success/20 text-success',
    pending: 'bg-warning/20 text-warning',
    rejected: 'bg-error/20 text-error',
    promoted: 'bg-accent/20 text-accent',
  };
  const label: Record<string, string> = {
    active: '已启用',
    pending: '待审核',
    rejected: '已拒绝',
    promoted: '已提升',
  };
  return <span className={`text-xs px-1.5 py-0.5 rounded ${map[s] || 'bg-surface-hover text-muted'}`}>{label[s] || s}</span>;
}

function scanBadge(s: string) {
  const map: Record<string, string> = {
    clean: 'bg-success/15 text-success',
    flagged: 'bg-error/15 text-error',
    pending: 'bg-surface-hover text-muted',
  };
  const label: Record<string, string> = { clean: '扫描通过', flagged: '已标记', pending: '未扫描' };
  return <span className={`text-xs px-1.5 py-0.5 rounded ${map[s] || 'bg-surface-hover text-muted'}`}>{label[s] || s}</span>;
}

export default function SkillsPage() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [mine, setMine] = useState<Skill[]>([]);
  const [global, setGlobal] = useState<Skill[]>([]);
  const [showGlobal, setShowGlobal] = useState(false);

  const loadMine = useCallback(async () => {
    try {
      const data = await apiGet('/skills/my');
      setMine(data.skills || []);
    } catch {}
  }, []);

  const loadGlobal = useCallback(async () => {
    try {
      const data = await apiGet('/skills/available');
      setGlobal(data.skills || []);
    } catch {}
  }, []);

  useEffect(() => { loadMine(); loadGlobal(); }, [loadMine, loadGlobal]);

  const install = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiPost('/skills/install', { url: url.trim() });
      const flagged = r.scanStatus === 'flagged';
      setMsg({
        ok: !flagged,
        text: flagged
          ? `已安装「${r.name}」，但安全扫描标记了风险，暂为待审核，需管理员提升后才会生效。`
          : `已安装「${r.name}」并已在你的账号内启用。`,
      });
      if (!flagged) setUrl('');
      loadMine();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || '安装失败' });
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async (id: string) => {
    if (!confirm('确定卸载此技能？')) return;
    try {
      await apiDelete(`/skills/my/${id}`);
      loadMine();
    } catch {}
  };

  return (
    <div className="min-h-screen bg-bg pb-20">
      <div className="max-w-lg mx-auto px-4 py-6">
        <div className="flex items-center gap-4 mb-6 anim-fade-up">
          <button onClick={() => router.push('/chat')} className="p-2 hover:bg-surface-hover rounded-card anim-press">
            <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <h1 className="text-xl font-display font-bold text-primary">技能</h1>
        </div>

        {/* Install from link */}
        <div className="glass-card-sm p-4 mb-5 anim-fade-up">
          <div className="text-sm font-medium text-primary mb-2">安装技能</div>
          <div className="text-xs text-muted mb-3">粘贴链接（GitHub 项目 / .md / .zip），该技能将安装到你的账号内，仅你可见。</div>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && install()}
            placeholder="https://github.com/owner/repo/tree/main/skills/xxx"
            className="w-full bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary focus:outline-none mb-3"
          />
          <button
            onClick={install}
            disabled={busy || !url.trim()}
            className="w-full py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 text-on-accent text-sm rounded-card anim-press"
          >
            {busy ? '安装中…' : '安装'}
          </button>
          {msg && (
            <div className={`mt-3 text-xs px-3 py-2 rounded ${msg.ok ? 'bg-success/15 text-success' : 'bg-error/15 text-error'}`}>{msg.text}</div>
          )}
        </div>

        {/* My skills */}
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium text-primary">我的技能（{mine.length}）</div>
        </div>
        <div className="space-y-2 mb-6">
          {mine.length === 0 ? (
            <div className="text-center text-muted py-6 glass-card-sm anim-fade-up text-sm">还没有安装技能</div>
          ) : mine.map((s, i) => (
            <div key={s.id} className="glass-card-sm p-4 anim-fade-up" style={{ animationDelay: `${i * 0.03}s` }}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-primary">{s.name}</span>
                  {statusBadge(s.status)}
                  {scanBadge(s.scanStatus)}
                </div>
                <button onClick={() => uninstall(s.id)} className="text-xs text-error hover:text-error/70 px-2 py-1">卸载</button>
              </div>
              {s.description && <p className="text-xs text-muted mb-2">{s.description}</p>}
              <pre className="text-xs text-muted bg-bg rounded p-2 overflow-x-auto max-h-24 whitespace-pre-wrap">{(s.prompt || '').substring(0, 300)}{String(s.prompt || '').length > 300 ? '…' : ''}</pre>
              <div className="mt-2 text-xs text-muted break-all">
                <span className="uppercase opacity-60">{s.sourceType}</span>
                {s.sourceUrl && <> · <a className="underline" href={s.sourceUrl} target="_blank" rel="noreferrer">{s.sourceUrl}</a></>}
              </div>
            </div>
          ))}
        </div>

        {/* Global pool */}
        <button onClick={() => setShowGlobal(!showGlobal)} className="text-xs text-muted mb-3 hover:text-primary anim-press">
          {showGlobal ? '收起' : '浏览全局技能'}（{global.length}）
        </button>
        {showGlobal && (
          <div className="space-y-2">
            {global.length === 0 ? <div className="text-center text-muted py-4 text-sm">暂无全局技能</div> :
              global.map((s) => (
                <div key={s.id} className="glass-card-sm p-3 anim-fade-up">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-primary">{s.name}</span>
                    {s.category && <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-muted">{s.category}</span>}
                  </div>
                  {s.description && <p className="text-xs text-muted mt-1">{s.description}</p>}
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
