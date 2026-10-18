// File workspace client — talks to /api/workspace.
// Replaces the old "download the whole message as .txt" behaviour with a real
// file capability: extract → list → read → save → ZIP/单文件 下载。
'use client';

import { getApiUrl } from './api';

const API_URL = getApiUrl();

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('cortex_token');
}

async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function readError(res: Response, fallback: string): Promise<never> {
  const data = await res.json().catch(() => ({} as { error?: string }));
  throw new Error(data?.error || fallback);
}

export interface WorkspaceFileMeta {
  path: string;
  size: number;
  language: string;
}

export interface WorkspaceTreeFile extends WorkspaceFileMeta {}

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
  size?: number;
  language?: string;
}

/** 创建：把一条消息里的代码块提取成文件（幂等，重复点不会重复写）。 */
export async function extractFilesFromMessage(
  conversationId: string,
  messageId: string,
  opts: { includeProse?: boolean } = {},
): Promise<{ created: number; updated: number; rejected: Array<{ raw: string; reason: string }>; files: WorkspaceFileMeta[] }> {
  const res = await fetch(`${API_URL}/workspace/${conversationId}/extract`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ messageId, includeProse: !!opts.includeProse }),
  });
  if (!res.ok) return readError(res, '提取失败');
  return res.json();
}

/** 读取：目录树 + 体积统计。 */
export async function fetchTree(conversationId: string): Promise<{ tree: TreeNode[]; count: number; bytes: number }> {
  const res = await fetch(`${API_URL}/workspace/${conversationId}/tree`, { headers: await authHeaders() });
  if (!res.ok) return readError(res, '读取目录失败');
  return res.json();
}

/** 读取：扁平列表，可按路径关键字过滤。 */
export async function fetchFiles(conversationId: string, q = ''): Promise<{ files: WorkspaceFileMeta[]; total: number }> {
  const res = await fetch(`${API_URL}/workspace/${conversationId}/files?q=${encodeURIComponent(q)}`, {
    headers: await authHeaders(),
  });
  if (!res.ok) return readError(res, '读取文件列表失败');
  return res.json();
}

/** 读取：单个文件完整内容。 */
export async function fetchFile(conversationId: string, path: string): Promise<{ path: string; content: string; language: string }> {
  const res = await fetch(`${API_URL}/workspace/${conversationId}/file?path=${encodeURIComponent(path)}`, {
    headers: await authHeaders(),
  });
  if (!res.ok) return readError(res, '读取文件失败');
  const data = await res.json();
  return data.file;
}

/** 修改：新建（409 = 已存在）。 */
export async function createFile(conversationId: string, path: string, content: string, language = 'txt') {
  const res = await fetch(`${API_URL}/workspace/${conversationId}/file`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ path, content, language }),
  });
  if (!res.ok) return readError(res, '创建文件失败');
  return res.json();
}

/** 修改：保存（不存在则创建，存在则覆盖）。 */
export async function saveFile(conversationId: string, path: string, content: string, language = 'txt') {
  const res = await fetch(`${API_URL}/workspace/${conversationId}/file`, {
    method: 'PUT',
    headers: await authHeaders(),
    body: JSON.stringify({ path, content, language }),
  });
  if (!res.ok) return readError(res, '保存文件失败');
  return res.json();
}

/** 修改：删除。 */
export async function deleteFile(conversationId: string, path: string) {
  const res = await fetch(`${API_URL}/workspace/${conversationId}/file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) return readError(res, '删除文件失败');
  return res.json();
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 下载：多文件 / 目录 / 完整项目 ZIP。paths 为空 = 整个工作台。 */
export async function downloadZip(conversationId: string, paths?: string[], root?: string): Promise<void> {
  const params = new URLSearchParams();
  if (paths && paths.length) params.set('paths', paths.join(','));
  if (root) params.set('root', root);
  const res = await fetch(`${API_URL}/workspace/${conversationId}/download?${params.toString()}`, {
    headers: await authHeaders(),
  });
  if (!res.ok) return readError(res, '打包失败');
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const filename = disposition.match(/filename="?([^"]+)"?/)?.[1] || 'project.zip';
  triggerDownload(blob, filename);
}

/** 下载：单个文件（保留真实文件名）。 */
export async function downloadFile(conversationId: string, path: string): Promise<void> {
  const res = await fetch(`${API_URL}/workspace/${conversationId}/download/file?path=${encodeURIComponent(path)}`, {
    headers: await authHeaders(),
  });
  if (!res.ok) return readError(res, '下载失败');
  const blob = await res.blob();
  triggerDownload(blob, path.split('/').pop() || 'file.txt');
}

const EXT_BY_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', py: 'py', sh: 'sh', json: 'json',
  md: 'md', html: 'html', css: 'css', sql: 'sql', yml: 'yml', yaml: 'yaml',
  txt: 'txt', go: 'go', rs: 'rs', java: 'java', vue: 'vue', svelte: 'svelte',
};

/**
 * 下载单个代码段（不落库）。这是"复制/下载"最直接的升级：点一下拿到的是一个
 * 真实文件，而不是整条消息的纯文本。文件名用 snippet-<n>.<ext>——它没有真实
 * 名字，就诚实地叫 snippet，不假装知道。
 */
export function downloadSnippet(code: string, language: string, index = 1, hint?: string): string {
  const base = (hint || `snippet-${index}`).replace(/[^\w.\-]+/g, '-');
  const ext = EXT_BY_LANG[language] || language || 'txt';
  const name = /\.\w+$/.test(base) ? base : `${base}.${ext}`;
  triggerDownload(new Blob([code], { type: 'text/plain;charset=utf-8' }), name);
  return name;
}
