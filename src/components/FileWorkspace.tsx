'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createFile, deleteFile, downloadFile, downloadZip, extractFilesFromMessage,
  fetchFile, fetchTree, saveFile,
  type TreeNode,
  type WorkspaceFileMeta,
} from '@/lib/fileWorkspace';

interface Props {
  conversationId: string | null;
  open: boolean;
  onClose: () => void;
  /** 由父组件触发"从某条消息提取文件" */
  extractTarget?: { messageId: string } | null;
  onToast?: (msg: string) => void;
}

type View = { kind: 'list' } | { kind: 'edit'; path: string; content: string; language: string; dirty: boolean }

export default function FileWorkspace({ conversationId, open, onClose, extractTarget, onToast }: Props) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [files, setFiles] = useState<WorkspaceFileMeta[]>([]);
  const [bytes, setBytes] = useState(0);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [newPath, setNewPath] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    setError('');
    try {
      const [t, f] = await Promise.all([fetchTree(conversationId), fetchFileList(conversationId)]);
      setTree(t.tree); setBytes(t.bytes); setFiles(f.files);
    } catch (e: any) { setError(e?.message || '读取失败'); }
    finally { setLoading(false); }
  }, [conversationId]);

  // fetchFileList 单独包一层：文件列表与目录树是两个端点，但 UI 需要两者
  const fetchFileList = useCallback(async (id: string) => {
    const mod = await import('@/lib/fileWorkspace');
    return mod.fetchFiles(id);
  }, []);

  useEffect(() => { if (open && conversationId) void reload(); }, [open, conversationId, reload]);

  // 父组件点击"提取为文件"后到这里真正执行
  useEffect(() => {
    if (!open || !conversationId || !extractTarget?.messageId) return;
    let alive = true;
    (async () => {
      setError('');
      try {
        const r = await extractFilesFromMessage(conversationId, extractTarget.messageId);
        if (!alive) return;
        onToast?.(r.created || r.updated ? `已提取 ${r.created + r.updated} 个文件` : '文件已是最新');
        await reload();
      } catch (e: any) { if (alive) setError(e?.message || '提取失败'); }
    })();
    return () => { alive = false; };
  }, [open, conversationId, extractTarget, reload, onToast]);

  const flat = useMemo(() => files.map((f) => f.path), [files]);

  const openFile = useCallback(async (path: string) => {
    if (!conversationId) return;
    setError('');
    try {
      const f = await fetchFile(conversationId, path);
      setView({ kind: 'edit', path: f.path, content: f.content, language: f.language, dirty: false });
    } catch (e: any) { setError(e?.message || '读取文件失败'); }
  }, [conversationId]);

  const save = useCallback(async () => {
    if (view.kind !== 'edit' || !conversationId) return;
    setError('');
    try {
      await saveFile(conversationId, view.path, view.content, view.language);
      setView({ ...view, dirty: false });
      onToast?.('已保存');
      await reload();
    } catch (e: any) { setError(e?.message || '保存失败'); }
  }, [view, conversationId, reload, onToast]);

  const create = useCallback(async () => {
    if (!conversationId || !newPath.trim()) return;
    setError('');
    try {
      await createFile(conversationId, newPath.trim(), '');
      setCreating(false); setNewPath('');
      onToast?.('已创建');
      await reload();
    } catch (e: any) { setError(e?.message || '创建失败'); }
  }, [conversationId, newPath, reload, onToast]);

  const remove = useCallback(async (path: string) => {
    if (!conversationId) return;
    setError('');
    try {
      await deleteFile(conversationId, path);
      if (view.kind === 'edit' && view.path === path) setView({ kind: 'list' });
      onToast?.('已删除');
      await reload();
    } catch (e: any) { setError(e?.message || '删除失败'); }
  }, [conversationId, view, reload, onToast]);

  const toggleSelect = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const downloadSelected = () => {
    if (!conversationId) return;
    const paths = [...selected];
    void downloadZip(conversationId, paths.length ? paths : undefined)
      .catch((e: any) => setError(e?.message || '打包失败'));
  };

  if (!open) return null;
  if (!conversationId) {
    return (
      <aside className="w-full sm:w-[380px] shrink-0 liquid-glass rounded-container p-4 text-sm text-muted">
        先创建或打开一个对话，才能使用文件工作台。
      </aside>
    );
  }

  return (
    <aside className="w-full sm:w-[380px] shrink-0 liquid-glass rounded-container flex flex-col overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3.5 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-primary">文件工作台</span>
          <span className="text-[11px] text-muted">{files.length} 个文件 · {(bytes / 1024).toFixed(1)} KB</span>
        </div>
        <button onClick={onClose} className="text-muted hover:text-primary transition-colors text-xs px-2 py-1 rounded hover:bg-surface-hover anim-press">关闭</button>
      </div>

      {/* 工具栏 */}
      <div className="flex flex-wrap gap-1.5 px-3.5 py-2.5 border-b border-border/50">
        <button onClick={() => { setCreating((v) => !v); setView({ kind: 'list' }); }}
          className="text-xs px-2.5 py-1.5 rounded-lg bg-accent/15 text-accent hover:bg-accent/25 transition-colors anim-press">+ 新建文件</button>
        <button onClick={downloadSelected}
          className="text-xs px-2.5 py-1.5 rounded-lg bg-surface-light hover:bg-surface-hover text-primary transition-colors anim-press">
          下载{selected.size ? `所选 (${selected.size})` : '整个项目'}
        </button>
        <button onClick={() => void reload()} className="text-xs px-2.5 py-1.5 rounded-lg bg-surface-light hover:bg-surface-hover text-muted transition-colors anim-press">刷新</button>
      </div>

      {error && <div className="mx-3.5 mt-2.5 rounded-card bg-error/10 border border-error/30 px-3 py-2 text-xs text-error">{error}</div>}

      {creating && (
        <div className="px-3.5 py-2.5 border-b border-border/50 flex gap-2">
          <input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="src/utils.ts"
            className="flex-1 bg-surface-light rounded-input px-2.5 py-1.5 text-xs text-primary outline-none border border-border/50 focus:border-accent/60 transition-colors" />
          <button onClick={() => void create()} className="text-xs px-2.5 py-1.5 rounded-lg bg-accent text-white anim-press">创建</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-xs text-muted">加载中…</div>
        ) : view.kind === 'edit' ? (
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border/50">
              <span className="text-xs font-mono text-primary truncate">{view.path}{view.dirty && <span className="text-accent"> *</span>}</span>
              <div className="flex gap-1.5">
                <button onClick={() => void save()} disabled={!view.dirty}
                  className="text-xs px-2 py-1 rounded bg-accent text-white disabled:opacity-40 anim-press">保存</button>
                <button onClick={() => void downloadFile(conversationId, view.path).catch((e) => setError(e?.message))}
                  className="text-xs px-2 py-1 rounded bg-surface-light text-primary anim-press">下载</button>
                <button onClick={() => void remove(view.path)} className="text-xs px-2 py-1 rounded bg-error/15 text-error anim-press">删除</button>
                <button onClick={() => setView({ kind: 'list' })} className="text-xs px-2 py-1 rounded bg-surface-light text-muted anim-press">返回</button>
              </div>
            </div>
            <textarea value={view.content} onChange={(e) => setView({ ...view, content: e.target.value, dirty: true })}
              spellCheck={false}
              className="flex-1 min-h-[280px] w-full bg-transparent px-3.5 py-3 text-xs font-mono leading-relaxed text-primary outline-none resize-none" />
          </div>
        ) : files.length === 0 ? (
          <div className="p-4 text-xs text-muted leading-relaxed">
            还没有文件。在任意一条模型回复下点「提取为文件」，代码块就会变成可读可改的文件。
          </div>
        ) : (
          <ul className="py-1">
            {flat.map((path) => {
              const meta = files.find((f) => f.path === path)!;
              const depth = path.split('/').length - 1;
              return (
                <li key={path} className="group flex items-center gap-1.5 px-3.5 py-1.5 hover:bg-surface-hover transition-colors">
                  <input type="checkbox" checked={selected.has(path)} onChange={() => toggleSelect(path)}
                    className="accent-accent w-3 h-3 shrink-0" aria-label={`选择 ${path}`} />
                  <button onClick={() => void openFile(path)} className="flex-1 text-left min-w-0">
                    <span className="font-mono text-xs text-primary truncate block" style={{ paddingLeft: depth * 10 }}>
                      {path.split('/').pop()}
                    </span>
                    <span className="text-[10px] text-muted">{meta.language} · {meta.size < 1024 ? `${meta.size} B` : `${(meta.size / 1024).toFixed(1)} KB`}</span>
                  </button>
                  <button onClick={() => void downloadFile(conversationId, path).catch((e) => setError(e?.message))}
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-[11px] text-accent transition-opacity">下载</button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 目录树（折叠在底部，不占主区） */}
      {view.kind === 'list' && tree.length > 0 && (
        <details className="border-t border-border/50">
          <summary className="px-3.5 py-2 text-[11px] text-muted cursor-pointer hover:text-primary transition-colors">目录结构</summary>
          <div className="px-3.5 pb-2.5 max-h-32 overflow-y-auto">
            {renderTree(tree)}
          </div>
        </details>
      )}
    </aside>
  );
}

function renderTree(nodes: TreeNode[], depth = 0): React.ReactNode {
  return nodes.map((n) => (
    <div key={n.path} className="font-mono text-[11px] text-muted whitespace-nowrap" style={{ paddingLeft: depth * 10 }}>
      {n.type === 'dir' ? '📁 ' : '📄 '}{n.name}
      {n.children && renderTree(n.children, depth + 1)}
    </div>
  ));
}
