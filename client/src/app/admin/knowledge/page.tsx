'use client';
import { useEffect, useState, useRef } from 'react';
import { apiGet, apiPost, apiDelete, apiPut } from '@/lib/api';

export default function AdminKnowledgePage() {
  const [folders, setFolders] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showFolderForm, setShowFolderForm] = useState(false);
  const [showZipUpload, setShowZipUpload] = useState(false);
  const [form, setForm] = useState({ title: '', content: '', category: 'general', evidenceLevel: 'C' });
  const [folderForm, setFolderForm] = useState({ name: '', description: '', isRules: false });
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchFolders = async () => {
    try { const data = await apiGet('/knowledge/folders'); setFolders(data.folders); } catch {}
  };

  const fetchItems = async (folderId?: string | null) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (folderId) params.set('folderId', folderId);
      else if (folderId === null) params.set('folderId', 'null');
      const data = await apiGet(`/knowledge?${params}`);
      setItems(data.items);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { fetchFolders(); fetchItems(null); }, []);

  const handleSelectFolder = (folderId: string | null) => {
    setSelectedFolder(folderId);
    fetchItems(folderId);
  };

  const handleAddFolder = async () => {
    try { await apiPost('/knowledge/folders', folderForm); setFolderForm({ name: '', description: '', isRules: false }); setShowFolderForm(false); fetchFolders(); } catch {}
  };

  const handleDeleteFolder = async (id: string) => {
    if (!confirm('删除文件夹？里面的知识条目不会被删除。')) return;
    try { await apiDelete(`/knowledge/folders/${id}`); if (selectedFolder === id) { setSelectedFolder(null); fetchItems(null); } fetchFolders(); } catch {}
  };

  const handleAdd = async () => {
    try {
      await apiPost('/knowledge', { ...form, folderId: selectedFolder || undefined });
      setForm({ title: '', content: '', category: 'general', evidenceLevel: 'C' });
      setShowAdd(false);
      fetchItems(selectedFolder);
    } catch {}
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除？')) return;
    try { await apiDelete(`/knowledge/${id}`); fetchItems(selectedFolder); } catch {}
  };

  const handleZipImport = async () => {
    if (!zipFile) return;
    setImporting(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result as string;
        try {
          const data = await apiPost('/knowledge/import-zip', {
            zipData: base64,
            folderId: selectedFolder || undefined,
            category: selectedFolder ? 'folder' : 'import',
          });
          alert(`导入完成：${data.imported} 个文件，${data.chunks} 个分块`);
          setShowZipUpload(false); setZipFile(null);
          fetchItems(selectedFolder);
        } catch (err: any) { alert('导入失败: ' + (err.message || '')); }
        finally { setImporting(false); }
      };
      reader.readAsDataURL(zipFile);
    } catch { setImporting(false); }
  };

  const levelColors: Record<string, string> = { S: 'bg-success/20 text-success', A: 'bg-accent/20 text-accent', B: 'bg-warning/20 text-warning', C: 'text-muted bg-surface-hover', D: 'bg-error/20 text-error' };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 anim-fade-up">
        <h1 className="text-2xl font-display font-bold text-primary">知识库管理</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowFolderForm(!showFolderForm)} className="px-3 py-2 bg-surface-hover text-primary text-sm rounded-card hover:bg-surface-light anim-press">+ 文件夹</button>
          <button onClick={() => setShowZipUpload(!showZipUpload)} className="px-3 py-2 bg-surface-hover text-primary text-sm rounded-card hover:bg-surface-light anim-press">📦 导入ZIP</button>
          <button onClick={() => setShowAdd(!showAdd)} className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm rounded-card anim-press">+ 添加知识</button>
        </div>
      </div>

      {showFolderForm && (
        <div className="glass-card-sm p-4 mb-4 anim-scale-in">
          <div className="flex gap-2 mb-2">
            <input value={folderForm.name} onChange={(e) => setFolderForm({ ...folderForm, name: e.target.value })} placeholder="文件夹名称" className="flex-1 bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary focus:outline-none" />
            <input value={folderForm.description} onChange={(e) => setFolderForm({ ...folderForm, description: e.target.value })} placeholder="描述（可选）" className="flex-1 bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary focus:outline-none" />
          </div>
          <div className="flex items-center gap-3 mb-2">
            <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
              <input type="checkbox" checked={folderForm.isRules} onChange={(e) => setFolderForm({ ...folderForm, isRules: e.target.checked })} className="accent-accent" />
              规则文件夹（内容将始终注入AI系统提示）
            </label>
          </div>
          <div className="flex gap-2">
            <button onClick={handleAddFolder} className="px-4 py-2 bg-accent text-on-accent text-sm rounded-card anim-press">创建</button>
            <button onClick={() => setShowFolderForm(false)} className="px-4 py-2 bg-surface-hover text-muted text-sm rounded-card">取消</button>
          </div>
        </div>
      )}

      {showZipUpload && (
        <div className="glass-card-sm p-4 mb-4 anim-scale-in">
          <div className="text-sm text-muted mb-2">选择ZIP文件导入到{selectedFolder ? '当前文件夹' : '根目录'}</div>
          <input ref={fileRef} type="file" accept=".zip" onChange={(e) => setZipFile(e.target.files?.[0] || null)} className="text-sm text-muted mb-3" />
          <div className="flex gap-2">
            <button onClick={handleZipImport} disabled={!zipFile || importing} className="px-4 py-2 bg-accent text-on-accent text-sm rounded-card disabled:opacity-30 anim-press">{importing ? '导入中...' : '开始导入'}</button>
            <button onClick={() => { setShowZipUpload(false); setZipFile(null); }} className="px-4 py-2 bg-surface-hover text-muted text-sm rounded-card">取消</button>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="glass-card-sm p-5 mb-4 anim-scale-in">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="标题" className="bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary focus:outline-none" />
            <select value={form.evidenceLevel} onChange={(e) => setForm({ ...form, evidenceLevel: e.target.value })} className="bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary focus:outline-none">
              <option value="S">S - 官方确认</option><option value="A">A - 多源一致</option><option value="B">B - 案例支持</option><option value="C">C - 社区经验</option><option value="D">D - 未验证</option>
            </select>
          </div>
          <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="知识内容..." className="w-full bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary focus:outline-none mb-3 h-24 resize-none" />
          <div className="flex gap-2">
            <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="分类" className="flex-1 bg-bg border border-border rounded-card px-3 py-2 text-sm text-primary focus:outline-none" />
            <button onClick={handleAdd} className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm rounded-card anim-press">保存</button>
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 bg-surface-hover text-muted text-sm rounded-card">取消</button>
          </div>
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-4">
        <div className="w-full lg:w-48 lg:flex-shrink-0">
          <div className="glass-card-sm overflow-hidden">
            <button onClick={() => handleSelectFolder(null)}
              className={`w-full px-3 py-2.5 text-left text-sm transition-colors ${selectedFolder === null ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-surface-hover'}`}>
              📁 全部 ({folders.reduce((s, f) => s + (f._count?.entries || 0), 0)})
            </button>
            {folders.map((f) => (
              <div key={f.id} className="group">
                <div className={`flex items-center gap-1 px-3 py-2.5 cursor-pointer transition-colors ${selectedFolder === f.id ? 'bg-accent/10' : 'hover:bg-surface-hover'}`}
                  onClick={() => handleSelectFolder(f.id)}>
                  <span className="text-sm">{f.isRules ? '🔒' : '📂'}</span>
                  <span className={`text-sm flex-1 truncate ${selectedFolder === f.id ? 'text-accent' : 'text-primary'}`}>{f.name}</span>
                  <span className="text-xs text-muted">{f._count?.entries || 0}</span>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteFolder(f.id); }}
                    className="opacity-0 group-hover:opacity-100 text-xs text-error ml-1 anim-press">✕</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 min-w-0">
          {loading ? (
            <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>
          ) : items.length === 0 ? (
            <div className="text-center text-muted py-12 glass-card-sm">此文件夹暂无知识条目</div>
          ) : (
            <div className="space-y-2">
              {items.map((item, i) => (
                <div key={item.id} className="glass-card-sm p-4 anim-fade-up" style={{ animationDelay: `${i * 0.03}s` }}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-primary">{item.title}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${levelColors[item.evidenceLevel]}`}>{item.evidenceLevel}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-muted">{item.category}</span>
                    </div>
                    <button onClick={() => handleDelete(item.id)} className="text-xs text-error hover:text-error/70 px-2 py-1">删除</button>
                  </div>
                  <p className="text-xs text-muted line-clamp-2">{item.content}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}