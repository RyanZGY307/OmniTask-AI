// ================================================================
// File Workspace — real file capability for chat output.
// ================================================================
// 原来「代码块复制/下载」名不副实：
//   - UI 的每个代码块下载按钮打的是 POST /chat/download-code，那个端点把整条
//     消息原样吐成 .txt（含全部散文、无文件名、无 ZIP）；
//   - MessageBubble 里「下载 ZIP (N个文件)」依赖 message.metadata.codeBlocks，
//     而服务端从不写这个字段 → 那段按钮从未渲染过。
// 本模块提供真实能力：把回答解析成「文件」→ 目录 → 可读可改 → ZIP 打包。
//
// 设计约束：
//   1. 路径安全优先于便利：绝对路径 / 盘符 / ".." 穿越一律拒绝（这是可被公开
//      触达的端点）。宁可不收，也不收一个能穿越的路径。
//   2. 纯函数核心：parse/buildTree/normalizePath/zipFiles 不碰 DB、不碰网络，
//      可在沙箱里完整回归测试。
//   3. 文件名推断是尽力而为：有声明就用声明（title=/filename=/File:），没有
//      才退到 file-N.<ext>，并明确记录 inferred 标记——不假装确定。
// ================================================================

import AdmZip from 'adm-zip';

export interface WorkspaceFileDraft {
  path: string;
  content: string;
  language: string;
  /** 文件名是从块声明推断出来的，还是从正文提示推断的（供 UI 标注不确定） */
  inferred: boolean;
  /** 该文件来自原文中的第几个代码块（从 1 开始），用于溯源 */
  blockIndex: number;
}

export interface WorkspaceFileRef {
  path: string;
  content: string;
  language: string;
}

export interface ParseResult {
  files: WorkspaceFileDraft[];
  /** 被拒绝的路径（穿越/绝对路径/空路径）——不静默丢弃 */
  rejected: Array<{ raw: string; reason: string }>;
  /** 消息正文里去掉代码块后的散文（可选用作 README） */
  prose: string;
}

// ==================== 路径安全 ====================

export interface PathCheck {
  ok: boolean;
  path?: string;
  reason?: string;
}

/**
 * 规范并校验一个相对路径。规则（按顺序，全部硬规则）：
 *   - 拒绝空路径；
 *   - 拒绝绝对路径（/、\、盘符 C:\）；
 *   - 拒绝任何 .. 段（目录穿越）；
 *   - 拒绝以 - 开头或含控制字符的段；
 *   - 折叠重复斜杠、去掉前导 "./"。
 */
export function normalizeWorkspacePath(raw: string): PathCheck {
  const input = String(raw ?? '').trim();
  if (!input) return { ok: false, reason: 'empty path' };

  let p = input.replace(/\\/g, '/');

  // Windows drive letter or UNC
  if (/^[A-Za-z]:/.test(p) || p.startsWith('//')) return { ok: false, reason: 'absolute path' };
  if (p.startsWith('/')) return { ok: false, reason: 'absolute path' };

  // Control characters / NUL
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return { ok: false, reason: 'control character in path' };

  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length) return { ok: false, reason: 'empty path after normalization' };
  for (const s of segs) {
    if (s === '..') return { ok: false, reason: 'path traversal' };
    if (s.startsWith('-')) return { ok: false, reason: 'segment starts with -' };
    if (/[<>:"|?*]/.test(s)) return { ok: false, reason: 'illegal character in segment' };
  }
  const normalized = segs.join('/');
  if (normalized.length > 400) return { ok: false, reason: 'path too long' };
  return { ok: true, path: normalized };
}

// ==================== 文件名推断 ====================

const LANG_EXT: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', typescript: 'ts', js: 'js', jsx: 'jsx', javascript: 'js',
  mjs: 'mjs', cjs: 'cjs', py: 'py', python: 'py', rb: 'rb', ruby: 'rb', go: 'go',
  rs: 'rs', rust: 'rs', java: 'java', kt: 'kt', kotlin: 'kt', swift: 'swift',
  c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp', cc: 'cc', hpp: 'hpp', cs: 'cs',
  csharp: 'cs', php: 'php', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
  ps1: 'ps1', powershell: 'ps1', json: 'json', jsonc: 'json', yaml: 'yaml',
  yml: 'yml', toml: 'toml', xml: 'xml', html: 'html', htm: 'htm', vue: 'vue',
  svelte: 'svelte', css: 'css', scss: 'scss', less: 'less', sql: 'sql',
  graphql: 'graphql', gql: 'graphql', proto: 'proto', dockerfile: 'dockerfile',
  makefile: 'mk', md: 'md', markdown: 'md', txt: 'txt', text: 'txt', ini: 'ini',
  env: 'env', conf: 'conf', diff: 'diff', patch: 'patch', lua: 'lua', r: 'r',
  dart: 'dart', scala: 'scala', ex: 'ex', exs: 'exs', erlang: 'erl', clj: 'clj',
};

const LANG_ALIAS: Record<string, string> = {
  typescript: 'ts', javascript: 'js', python: 'py', shell: 'sh', bash: 'sh',
  markdown: 'md', text: 'txt', 'c++': 'cpp', csharp: 'cs', rust: 'rs',
  kotlin: 'kt', ruby: 'rb', yml: 'yml',
};

export function normalizeLanguage(lang: string): string {
  const l = String(lang ?? '').trim().toLowerCase();
  if (!l) return 'txt';
  return LANG_ALIAS[l] ?? l;
}

function extForLanguage(lang: string): string {
  const l = normalizeLanguage(lang);
  return LANG_EXT[l] ?? l.replace(/[^a-z0-9]/g, '') ?? 'txt';
}

const FILENAME_HINT_RE =
  /(?:title|filename|file\s*name|file|path|name)\s*=\s*["']?([^"'\s]+)["']?/i;

/** 代码块上一行的文件名提示：### `src/a.ts` / **a.ts** / File: a.ts */
const HEADING_PATH_RE =
  /^(?:#{1,6}\s*|[-*]\s*|\d+\.\s*)?(?:file|files)?:?\s*[`*_]*([\w.\-\/@]+)[`*_]*\s*$/i;

function looksLikePath(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 200) return false;
  if (!/^[\w.\-\/@]+$/.test(t)) return false;
  // 必须有个扩展名或是个已知无扩展名文件名（Dockerfile/Makefile/LICENSE）
  return /\.\w{1,10}$/.test(t) || /^(dockerfile|makefile|license|readme)$/i.test(t);
}

interface Hint {
  path: string;
  source: 'declared' | 'heading' | 'fallback';
}

function inferHint(infoString: string, prevLine: string, blockIndex: number, lang: string): Hint {
  const declared = FILENAME_HINT_RE.exec(infoString || '');
  if (declared && looksLikePath(declared[1])) return { path: declared[1], source: 'declared' };

  const heading = HEADING_PATH_RE.exec((prevLine || '').trim());
  if (heading && looksLikePath(heading[1])) return { path: heading[1], source: 'heading' };

  // 上一行是 "File: src/a.ts" / "文件：src/a.ts" 这类中文前缀
  const cn = /^(?:文件|文件名|路径)\s*[:：]?\s*[`*_]*([\w.\-\/@]+)[`*_]*/i.exec((prevLine || '').trim());
  if (cn && looksLikePath(cn[1])) return { path: cn[1], source: 'heading' };

  return { path: `file-${blockIndex}.${extForLanguage(lang)}`, source: 'fallback' };
}

// ==================== 解析 ====================

const FENCE_RE = /(?:^|\n)([ \t]*)(`{3,}|~{3,})[ \t]*([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\2|^\2[ \t]*$)/gm;

/**
 * 把一条消息解析成多个文件。逐行扫描而不是一条大正则，才能在拒绝坏路径时保留
 * 上下文（原文片段）供调用方报告。
 */
export function parseWorkspaceFiles(content: string, opts: { includeProse?: boolean } = {}): ParseResult {
  const files: WorkspaceFileDraft[] = [];
  const rejected: ParseResult['rejected'] = [];
  const lines = String(content ?? '').split('\n');
  const proseLines: string[] = [];

  let blockIndex = 0;
  let i = 0;
  while (i < lines.length) {
    const open = /^[ \t]*(`{3,}|~{3,})[ \t]*(.*)$/.exec(lines[i]);
    if (open) {
      const marker = open[1];
      const info = open[2] || '';
      const langMatch = /[\w+#]+/.exec(info.split(/\s+/)[0] || '');
      const language = normalizeLanguage(langMatch ? langMatch[0] : '');

      let j = i + 1;
      const body: string[] = [];
      let closed = false;
      while (j < lines.length) {
        if (new RegExp(`^[ \\t]*${marker[0]}{${marker.length},}[ \\t]*$`).test(lines[j])) { closed = true; break; }
        body.push(lines[j]);
        j++;
      }

      // 取代码块之前最近的一个非空行作为提示来源
      let prev = '';
      for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
        if (lines[k].trim()) { prev = lines[k]; break; }
      }

      blockIndex++;
      const hint = inferHint(info, prev, blockIndex, language);
      const check = normalizeWorkspacePath(hint.path);
      if (!check.ok) {
        rejected.push({ raw: hint.path, reason: check.reason || 'invalid path' });
      } else {
        files.push({
          path: check.path!,
          content: body.join('\n'),
          language,
          inferred: hint.source !== 'declared',
          blockIndex,
        });
      }

      i = closed ? j + 1 : j;
      continue;
    }
    if (lines[i].trim()) proseLines.push(lines[i]);
    i++;
  }

  // 同名去重：第二个起加 -2/-3 后缀（保留扩展名）
  const seen = new Map<string, number>();
  for (const f of files) {
    const n = (seen.get(f.path) ?? 0) + 1;
    seen.set(f.path, n);
    if (n > 1) {
      const dot = f.path.lastIndexOf('.');
      const slug = dot > 0 ? `${f.path.slice(0, dot)}-${n}${f.path.slice(dot)}` : `${f.path}-${n}`;
      f.path = slug;
      seen.set(f.path, 1);
    }
  }

  const prose = proseLines.join('\n').trim();
  if (opts.includeProse && prose) {
    const check = normalizeWorkspacePath('README.md');
    if (check.ok) {
      files.push({ path: 'README.md', content: prose, language: 'md', inferred: false, blockIndex: 0 });
    }
  }
  return { files, rejected, prose };
}

// ==================== 目录树 ====================

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
  size?: number;
  language?: string;
}

/** 由扁平文件列表构建目录树；目录排序在文件之前，各自按名称。 */
export function buildFileTree(files: WorkspaceFileRef[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
  for (const f of files) {
    const segs = f.path.split('/');
    let cur = root;
    for (let k = 0; k < segs.length; k++) {
      const last = k === segs.length - 1;
      const seg = segs[k];
      cur.children = cur.children ?? [];
      let next = cur.children.find((c) => c.name === seg && c.type === (last ? 'file' : 'dir'));
      if (!next) {
        next = last
          ? { name: seg, path: segs.join('/'), type: 'file', size: f.content.length, language: f.language }
          : { name: seg, path: segs.slice(0, k + 1).join('/'), type: 'dir', children: [] };
        cur.children.push(next);
      }
      cur = next;
    }
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    for (const n of nodes) if (n.children) sort(n.children);
  };
  sort(root.children ?? []);
  return root.children ?? [];
}

/** 扁平化目录树，便于逐行渲染（带缩进深度）。 */
export function flattenTree(nodes: TreeNode[], depth = 0): Array<TreeNode & { depth: number }> {
  const out: Array<TreeNode & { depth: number }> = [];
  for (const n of nodes) {
    out.push({ ...n, depth });
    if (n.children) out.push(...flattenTree(n.children, depth + 1));
  }
  return out;
}

// ==================== ZIP 打包 ====================

/**
 * 真实 ZIP（PK）打包。paths 为空 = 完整项目；给出 paths = 多文件下载；
 * 路径指向目录时自动带上该目录下所有文件。
 */
export function zipWorkspaceFiles(
  files: WorkspaceFileRef[],
  opts: { rootName?: string; paths?: string[] } = {},
): Buffer {
  let selected = files;
  if (opts.paths && opts.paths.length) {
    const wanted = opts.paths.map((p) => p.replace(/\/+$/, ''));
    selected = files.filter((f) =>
      wanted.some((w) => f.path === w || f.path.startsWith(`${w}/`)),
    );
  }
  const zip = new AdmZip();
  const root = opts.rootName?.replace(/^\/+|\/+$/g, '');
  for (const f of selected) {
    const target = root ? `${root}/${f.path}` : f.path;
    zip.addFile(target, Buffer.from(String(f.content ?? ''), 'utf8'));
  }
  return zip.toBuffer();
}

/** 供 UI 显示的体积（字节数）。 */
export function workspaceBytes(files: WorkspaceFileRef[]): number {
  return files.reduce((sum, f) => sum + Buffer.byteLength(String(f.content ?? ''), 'utf8'), 0);
}
