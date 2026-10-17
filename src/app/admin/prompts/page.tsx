'use client';
import { useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut } from '@/lib/api';

type Tab = 'scenarios' | 'atoms' | 'preview';

function parseJson(s: any): string[] {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

export default function AdminPromptsPage() {
  const [tab, setTab] = useState<Tab>('scenarios');
  const [scenarios, setScenarios] = useState<any[]>([]);
  const [atoms, setAtoms] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [openScenario, setOpenScenario] = useState<string | null>(null);
  const [openAtom, setOpenAtom] = useState<string | null>(null);
  const [editAtom, setEditAtom] = useState<{ id: string; instruction: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [previewMessage, setPreviewMessage] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [s, a] = await Promise.all([apiGet('/prompt/scenarios'), apiGet('/prompt/atoms')]);
      setScenarios(s.scenarios || []);
      setAtoms(a.atoms || []);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { fetchAll(); }, []);

  const toast = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(''), 3000); };

  return (
    <div>
      <div className="flex items-center justify-between mb-4 anim-fade-up">
        <h1 className="text-2xl font-display font-bold text-primary">系统提示词</h1>
        <div className="flex gap-1 bg-surface rounded-card p-1">
          {([['scenarios', '场景组'], ['atoms', '提示词原子'], ['preview', '组合预览']] as [Tab, string][]).map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-xs rounded-card transition-colors ${tab === t ? 'bg-accent text-on-accent' : 'text-muted hover:text-primary'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {notice && <div className="mb-4 rounded-card bg-success/10 border border-success/30 text-success text-xs px-3 py-2 anim-fade-in">{notice}</div>}

      {loading ? <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div> : (
        <>
          {tab === 'scenarios' && (
            <ScenariosTab scenarios={scenarios} openId={openScenario} onToggle={(id: string) => setOpenScenario(openScenario === id ? null : id)}
              onRefresh={() => { fetchAll(); toast('已更新'); }} />
          )}
          {tab === 'atoms' && (
            <AtomsTab atoms={atoms} openId={openAtom} onToggle={(id: string) => setOpenAtom(openAtom === id ? null : id)}
              editAtom={editAtom} setEditAtom={setEditAtom} saving={saving} setSaving={setSaving}
              onSaved={() => { setEditAtom(null); fetchAll(); toast('已发布新版本'); }} />
          )}
          {tab === 'preview' && (
            <div className="glass-card-sm p-4 anim-fade-up">
              <textarea value={previewMessage} onChange={(e) => setPreviewMessage(e.target.value)} rows={3}
                placeholder="输入一条示例用户消息，预览组合后的完整系统提示词..."
                className="w-full bg-bg border border-border rounded-card px-4 py-2.5 text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/50" />
              <button onClick={async () => {
                if (!previewMessage.trim()) return;
                setPreviewLoading(true);
                try { setPreview(await apiPost('/prompt/compose', { message: previewMessage })); } catch { toast('预览失败'); }
                setPreviewLoading(false);
              }} disabled={previewLoading}
                className="mt-2 px-4 py-2 bg-accent text-on-accent text-xs rounded-card anim-press disabled:opacity-50">
                {previewLoading ? '组合中...' : '预览组合'}
              </button>
              {preview && (
                <div className="mt-4 space-y-3">
                  <div className="text-xs text-muted">场景：<span className="text-primary font-mono">{preview.scenario?.id || '—'}</span> · 任务：<span className="text-primary font-mono">{(preview.tasks || []).join(', ')}</span> · 温度：<span className="text-primary font-mono">{preview.temperature}</span></div>
                  {(preview.selected_atoms?.length > 0) && (
                    <div className="flex flex-wrap gap-1.5">
                      {preview.selected_atoms.map((a: any) => <span key={a.id} className="text-[10px] px-2 py-0.5 rounded bg-surface border border-border text-muted font-mono">{a.id}</span>)}
                    </div>
                  )}
                  <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-primary bg-bg rounded-card border border-border p-4 max-h-[500px] overflow-y-auto font-mono">{preview.final_system_prompt}</pre>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ScenariosTab({ scenarios, openId, onToggle, onRefresh }: any) {
  const toggleStatus = async (s: any) => {
    const next = s.status === 'published' ? 'draft' : 'published';
    try { await apiPut(`/prompt/scenarios/${s.id}/status`, { status: next }); onRefresh(); } catch {}
  };

  return (
    <div className="space-y-2">
      {scenarios.map((s: any, i: number) => (
        <div key={s.id} className="glass-card-sm overflow-hidden anim-fade-up" style={{ animationDelay: `${Math.min(i, 8) * 0.03}s` }}>
          <button onClick={() => onToggle(s.id)} className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-surface-hover/50 transition-colors">
            <span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${s.status === 'published' ? 'bg-success/20 text-success' : 'bg-surface text-muted border border-border'}`}>
              {s.status === 'published' ? '启用' : '停用'}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-primary truncate">{s.name} <span className="text-xs text-muted font-mono">({s.id})</span></div>
              <div className="text-xs text-muted truncate">{s.description}</div>
            </div>
            <span className="text-xs text-muted whitespace-nowrap">{s.category}</span>
            <span className="text-muted text-xs">{openId === s.id ? '▲' : '▼'}</span>
          </button>
          {openId === s.id && (
            <div className="border-t border-border/50 px-4 py-4 bg-surface/30 space-y-3 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-muted">状态切换：</span>
                <button onClick={() => toggleStatus(s)} className={`px-3 py-1 rounded text-xs transition-colors ${s.status === 'published' ? 'bg-error/10 text-error hover:bg-error/20' : 'bg-success/10 text-success hover:bg-success/20'}`}>
                  {s.status === 'published' ? '停用' : '启用'}
                </button>
              </div>
              <div><span className="text-muted">必选原子：</span><span className="text-primary font-mono">{parseJson(s.required_atoms).join(', ') || '—'}</span></div>
              <div><span className="text-muted">禁止原子：</span><span className="text-primary font-mono">{parseJson(s.forbidden_atoms).join(', ') || '—'}</span></div>
              <div><span className="text-muted">可选原子：</span><span className="text-primary font-mono">{parseJson(s.optional_atoms).join(', ') || '—'}</span></div>
              {parseJson(s.subtasks).length > 0 && (
                <div><span className="text-muted">子任务：</span><span className="text-primary">{parseJson(s.subtasks).join(' → ')}</span></div>
              )}
              <div><span className="text-muted">标签：</span><span className="text-muted font-mono">{parseJson(s.tags).join(', ') || '—'}</span></div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AtomsTab({ atoms, openId, onToggle, editAtom, setEditAtom, saving, setSaving, onSaved }: any) {
  const grouped: Record<string, any[]> = {};
  for (const a of atoms) (grouped[a.category] = grouped[a.category] || []).push(a);

  const publishNewVersion = async () => {
    if (!editAtom) return;
    setSaving(true);
    try {
      const ver = `v${Date.now().toString(36)}`;
      await apiPost(`/prompt/atoms/${editAtom.id}/version`, { version: ver, instruction: editAtom.instruction, metadata: { published: true }, created_by: 'admin' });
      await apiPut(`/prompt/atoms/${editAtom.id}/version/${ver}/publish`);
      onSaved();
    } catch {} finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      {Object.entries(grouped).map(([category, list]) => (
        <div key={category}>
          <div className="text-xs text-muted uppercase tracking-wider mb-2 font-mono">{category}</div>
          <div className="space-y-2">
            {(list as any[]).map((a) => {
              const current = a.versions?.[0];
              return (
                <div key={a.id} className="glass-card-sm overflow-hidden">
                  <button onClick={() => { onToggle(a.id); if (openId !== a.id) setEditAtom(null); }} className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-surface-hover/50 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-primary font-mono truncate">{a.id}</div>
                      <div className="text-xs text-muted truncate">{a.purpose}</div>
                    </div>
                    {current && <span className="text-[10px] text-muted font-mono whitespace-nowrap">{current.version}</span>}
                    <span className="text-muted text-xs">{openId === a.id ? '▲' : '▼'}</span>
                  </button>
                  {openId === a.id && (
                    <div className="border-t border-border/50 px-4 py-4 bg-surface/30 space-y-2">
                      {editAtom?.id === a.id ? (
                        <>
                          <textarea value={editAtom.instruction} onChange={(e) => setEditAtom({ ...editAtom, instruction: e.target.value })}
                            rows={8} className="w-full bg-bg border border-border rounded-card px-3 py-2 text-xs font-mono text-primary focus:outline-none focus:border-accent/50" />
                          <div className="flex gap-2">
                            <button onClick={publishNewVersion} disabled={saving}
                              className="px-4 py-1.5 bg-accent text-on-accent text-xs rounded-card anim-press disabled:opacity-50">
                              {saving ? '发布中...' : '保存并发布新版本'}
                            </button>
                            <button onClick={() => setEditAtom(null)} className="px-4 py-1.5 bg-surface-hover text-muted text-xs rounded-card">取消</button>
                          </div>
                        </>
                      ) : (
                        <>
                          <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-primary bg-bg rounded-card border border-border p-3 font-mono">{current?.instruction || '（无已发布版本）'}</pre>
                          <button onClick={() => setEditAtom({ id: a.id, instruction: current?.instruction || '' })}
                            className="px-4 py-1.5 bg-surface-hover text-primary text-xs rounded-card hover:bg-border transition-colors">
                            编辑
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
