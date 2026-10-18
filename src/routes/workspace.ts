// ================================================================
// Workspace routes — file capability for chat output.
// 创建 → 读取 → 修改 → 多文件 → 目录 → 完整项目 → ZIP/文件下载
// ================================================================
// 旧的 POST /chat/download-code 被本模块取代（它只把整条消息吐成 .txt）。
// 所有端点都要求登录，且校验会话归属——用户只能动自己的文件。
// 路径校验统一走 fileWorkspace.normalizeWorkspacePath：绝对路径 / ".." 穿越
// 一律拒绝，宁可不收，也不收一个能穿越的路径。
// ================================================================

import { Router, Response } from 'express';
import AdmZip from 'adm-zip';
import { prismaConversation } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import {
  buildFileTree,
  normalizeWorkspacePath,
  parseWorkspaceFiles,
  workspaceBytes,
  zipWorkspaceFiles,
  type WorkspaceFileRef,
} from '../services/fileWorkspace';

const router = Router();

/** 单条消息 / 单个主题允许的最大文件数与体积，防止一次解析把 DB 撑爆。 */
const MAX_FILES_PER_EXTRACT = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function assertConversationOwner(conversationId: string, userId: string): Promise<boolean> {
  const conv = await prismaConversation.conversation.findFirst({ where: { id: conversationId, userId } });
  return !!conv;
}

function slugForDownload(name: string): string {
  return name.replace(/[^\w.\-]+/g, '-').slice(0, 60) || 'project';
}

// ================================================================
// 创建：从一条消息提取文件
// POST /:conversationId/extract  { messageId, includeProse? }
// ================================================================
router.post('/:conversationId/extract', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversationId = String(req.params.conversationId);
    const { messageId, includeProse } = req.body ?? {};
    if (!messageId) return res.status(400).json({ error: '缺少 messageId' });
    if (!(await assertConversationOwner(conversationId, req.user!.id)))
      return res.status(404).json({ error: '对话不存在' });

    const message = await prismaConversation.message.findFirst({
      where: { id: String(messageId), conversationId },
    });
    if (!message) return res.status(404).json({ error: '消息不存在' });

    const parsed = parseWorkspaceFiles(message.content || '', { includeProse: !!includeProse });
    if (!parsed.files.length) {
      return res.status(422).json({ error: '这条消息里没有可提取的代码块', rejected: parsed.rejected });
    }
    if (parsed.files.length > MAX_FILES_PER_EXTRACT) {
      return res.status(413).json({ error: `一次最多提取 ${MAX_FILES_PER_EXTRACT} 个文件` });
    }

    let created = 0;
    let updated = 0;
    for (const f of parsed.files) {
      if (Buffer.byteLength(f.content, 'utf8') > MAX_FILE_BYTES) continue;
      const existing = await prismaConversation.workspaceFile.findUnique({
        where: { conversationId_path: { conversationId, path: f.path } },
      });
      // 内容相同不重复写（幂等）：重复点"提取"不该把 updatedAt 全刷一遍。
      if (existing) {
        if (existing.content !== f.content) {
          await prismaConversation.workspaceFile.update({
            where: { id: existing.id },
            data: { content: f.content, language: f.language, messageId: String(messageId), source: 'extracted' },
          });
          updated++;
        }
        continue;
      }
      await prismaConversation.workspaceFile.create({
        data: {
          conversationId, path: f.path, content: f.content, language: f.language,
          messageId: String(messageId), source: 'extracted',
        },
      });
      created++;
    }

    const files = await prismaConversation.workspaceFile.findMany({ where: { conversationId }, orderBy: { path: 'asc' } });
    res.json({
      created, updated,
      rejected: parsed.rejected,
      files: files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content, 'utf8'), language: f.language })),
      tree: buildFileTree(files.map((f) => ({ path: f.path, content: f.content, language: f.language }))),
    });
  } catch (err: any) {
    console.error('[workspace] extract failed:', err?.message);
    res.status(500).json({ error: '提取失败' });
  }
});

// ================================================================
// 读取：目录树 / 列表 / 单文件
// GET /:conversationId/tree
// GET /:conversationId/files?q=
// GET /:conversationId/file?path=a.ts
// ================================================================
async function loadOwnedFiles(conversationId: string, userId: string) {
  if (!(await assertConversationOwner(conversationId, userId))) return null;
  const rows = await prismaConversation.workspaceFile.findMany({ where: { conversationId }, orderBy: { path: 'asc' } });
  return rows.map((r) => ({ path: r.path, content: r.content, language: r.language, source: r.source, messageId: r.messageId }));
}

router.get('/:conversationId/tree', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const files = await loadOwnedFiles(String(req.params.conversationId), req.user!.id);
    if (!files) return res.status(404).json({ error: '对话不存在' });
    res.json({
      tree: buildFileTree(files),
      count: files.length,
      bytes: workspaceBytes(files),
    });
  } catch { res.status(500).json({ error: '读取目录失败' }); }
});

router.get('/:conversationId/files', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const files = await loadOwnedFiles(String(req.params.conversationId), req.user!.id);
    if (!files) return res.status(404).json({ error: '对话不存在' });
    const q = String(req.query.q || '').trim().toLowerCase();
    const filtered = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
    res.json({
      files: filtered.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content, 'utf8'), language: f.language })),
      total: filtered.length,
    });
  } catch { res.status(500).json({ error: '读取文件列表失败' }); }
});

router.get('/:conversationId/file', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversationId = String(req.params.conversationId);
    const check = normalizeWorkspacePath(String(req.query.path || ''));
    if (!check.ok) return res.status(400).json({ error: `路径不合法：${check.reason}` });
    const files = await loadOwnedFiles(conversationId, req.user!.id);
    if (!files) return res.status(404).json({ error: '对话不存在' });
    const file = files.find((f) => f.path === check.path);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    res.json({ file });
  } catch { res.status(500).json({ error: '读取文件失败' }); }
});

// ================================================================
// 修改：新建（冲突即 409） / 覆盖（创建或更新）
// POST /:conversationId/file  { path, content, language? }
// PUT  /:conversationId/file  { path, content, language? }
// DELETE /:conversationId/file?path=a.ts
// ================================================================
router.post('/:conversationId/file', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversationId = String(req.params.conversationId);
    const check = normalizeWorkspacePath(String(req.body?.path || ''));
    if (!check.ok) return res.status(400).json({ error: `路径不合法：${check.reason}` });
    const content = String(req.body?.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return res.status(413).json({ error: '文件过大' });
    if (!(await assertConversationOwner(conversationId, req.user!.id)))
      return res.status(404).json({ error: '对话不存在' });

    const existing = await prismaConversation.workspaceFile.findUnique({
      where: { conversationId_path: { conversationId, path: check.path! } },
    });
    // 409 而不是覆盖：新建语义下静默替换别人的内容是数据丢失。
    if (existing) return res.status(409).json({ error: '文件已存在', exists: true });

    const created = await prismaConversation.workspaceFile.create({
      data: {
        conversationId, path: check.path!, content,
        language: String(req.body?.language || 'txt'), source: 'manual',
      },
    });
    res.status(201).json({ file: { path: created.path, content: created.content, language: created.language, source: 'manual' } });
  } catch (err: any) {
    console.error('[workspace] create failed:', err?.message);
    res.status(500).json({ error: '创建文件失败' });
  }
});

router.put('/:conversationId/file', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversationId = String(req.params.conversationId);
    const check = normalizeWorkspacePath(String(req.body?.path || ''));
    if (!check.ok) return res.status(400).json({ error: `路径不合法：${check.reason}` });
    const content = String(req.body?.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return res.status(413).json({ error: '文件过大' });
    if (!(await assertConversationOwner(conversationId, req.user!.id)))
      return res.status(404).json({ error: '对话不存在' });

    const language = String(req.body?.language || 'txt');
    const key = { conversationId_path: { conversationId, path: check.path! } };
    const written = await prismaConversation.workspaceFile.upsert({
      where: key,
      create: { conversationId, path: check.path!, content, language, source: 'manual' },
      update: { content, language, source: 'manual' },
    });
    res.json({ file: { path: written.path, content: written.content, language: written.language, source: 'manual' } });
  } catch (err: any) {
    console.error('[workspace] update failed:', err?.message);
    res.status(500).json({ error: '保存文件失败' });
  }
});

router.delete('/:conversationId/file', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversationId = String(req.params.conversationId);
    const check = normalizeWorkspacePath(String(req.query.path || ''));
    if (!check.ok) return res.status(400).json({ error: `路径不合法：${check.reason}` });
    if (!(await assertConversationOwner(conversationId, req.user!.id)))
      return res.status(404).json({ error: '对话不存在' });
    const found = await prismaConversation.workspaceFile.findUnique({
      where: { conversationId_path: { conversationId, path: check.path! } },
    });
    if (!found) return res.status(404).json({ error: '文件不存在' });
    await prismaConversation.workspaceFile.delete({ where: { id: found.id } });
    res.json({ ok: true, path: check.path });
  } catch { res.status(500).json({ error: '删除文件失败' }); }
});

// ================================================================
// 下载：多文件 / 目录 / 完整项目 ZIP；单文件直下
// GET /:conversationId/download?paths=a.ts,b&root=name
// GET /:conversationId/download/file?path=a.ts
// ================================================================
router.get('/:conversationId/download', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversationId = String(req.params.conversationId);
    const files = await loadOwnedFiles(conversationId, req.user!.id);
    if (!files) return res.status(404).json({ error: '对话不存在' });
    if (!files.length) return res.status(404).json({ error: '工作台还是空的' });

    const rawPaths = String(req.query.paths || '').split(',').map((s) => s.trim()).filter(Boolean);
    // 每个提交的路径都要过校验——选择器里的坏路径不能让下载端静默忽略。
    for (const p of rawPaths) {
      const check = normalizeWorkspacePath(p);
      if (!check.ok) return res.status(400).json({ error: `路径不合法：${p}（${check.reason}）` });
    }

    const conv = await prismaConversation.conversation.findFirst({ where: { id: conversationId, userId: req.user!.id } });
    const root = String(req.query.root || (conv?.title ? slugForDownload(conv.title) : 'project'));
    const zip = zipWorkspaceFiles(files, { paths: rawPaths.length ? rawPaths : undefined, rootName: root });
    const label = rawPaths.length === 1 ? rawPaths[0].replace(/[^\w.\-]+/g, '-') : `${root}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${label}"`);
    res.setHeader('X-Workspace-Files', String(zipWorkspaceFiles(files, { paths: rawPaths.length ? rawPaths : undefined }).length));
    res.send(zip);
  } catch (err: any) {
    console.error('[workspace] download failed:', err?.message);
    res.status(500).json({ error: '打包失败' });
  }
});

router.get('/:conversationId/download/file', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversationId = String(req.params.conversationId);
    const check = normalizeWorkspacePath(String(req.query.path || ''));
    if (!check.ok) return res.status(400).json({ error: `路径不合法：${check.reason}` });
    const files = await loadOwnedFiles(conversationId, req.user!.id);
    if (!files) return res.status(404).json({ error: '对话不存在' });
    const file = files.find((f) => f.path === check.path);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const name = file.path.split('/').pop() || 'file.txt';
    const type = file.language === 'unknown' ? 'text/plain' : mimeFor(file.language);
    res.setHeader('Content-Type', `${type}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(Buffer.from(file.content, 'utf8'));
  } catch { res.status(500).json({ error: '下载失败' }); }
});

/** 语言 → 常见 MIME（未知则 text/plain，宁可保守也别让浏览器执行它）。 */
function mimeFor(language: string): string {
  const map: Record<string, string> = {
    ts: 'text/plain', tsx: 'text/plain', js: 'text/javascript', jsx: 'text/javascript',
    json: 'application/json', md: 'text/markdown', html: 'text/html', css: 'text/css',
    py: 'text/x-python', sh: 'text/x-shellscript', sql: 'text/plain', yml: 'text/yaml',
    yaml: 'text/yaml', txt: 'text/plain',
  };
  return map[language] ?? 'text/plain';
}

export default router;
