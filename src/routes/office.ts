// ================================================================
// Office / Document routes — generation, download, preview,
// and deterministic format transformation.
//
//   POST /api/chat/office/generate       — spec card confirm (kind office-gen)
//   POST /api/chat/office/convert        — existing artifact → new format (no AI)
//   GET  /api/chat/office/:messageId/download  — original file
//   GET  /api/chat/office/:messageId/preview   — preview representation
//
// Mount: /api/chat/office
// ================================================================

import { Router, Response } from 'express';
import { prisma, prismaConversation } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import {
  runOfficeGeneration, transformOfficeArtifact,
} from '../services/office/runtime';
import {
  OFFICE_MIME, OFFICE_EXT, OFFICE_FORMATS,
  type OfficeFormat,
} from '../services/office/types';
import { loadOfficeFile } from '../services/office/storage';
import { checkDailyLimit } from '../services/credits';

const router = Router();

function parseMeta(msg: any): any {
  try { return msg.metadata ? JSON.parse(msg.metadata) : null; } catch { return null; }
}

// Default presentation / spreadsheet / document formats come from the
// unified config (not hardcoded in the UI).
const DEFAULT_FORMATS = {
  presentation: 'pptx',
  document: 'docx',
  spreadsheet: 'xlsx',
} as const;

// POST /api/chat/office/generate
// body: { confirmMessageId, params: { artifactType, format, contentOverview,
//   title, audience, pageOrSlideCount, documentType, style, sourceArtifactId } }
router.post('/generate', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { confirmMessageId, params } = req.body || {};

    const msg = confirmMessageId
      ? await prismaConversation.message.findFirst({
        where: { id: String(confirmMessageId), conversation: { userId } },
      })
      : null;

    // Confirm-card flow: the card must exist and be pending.
    if (confirmMessageId && !msg) {
      return res.status(404).json({ ok: false, error: '确认消息不存在' });
    }
    if (msg) {
      const meta = parseMeta(msg);
      if (!meta || meta.status !== 'pending' || meta.kind !== 'office-gen') {
        return res.status(409).json({ ok: false, error: '该规格卡已处理', media: meta });
      }
    }

    // Office generation is a Free-unlimited capability (like audio):
    // no daily counter, no credit deduction. Concurrency guards apply.
    const artifactType: string =
      String(params?.artifactType ?? (msg ? parseMeta(msg)?.params?.artifactType : 'document'));
    const format: string =
      String(params?.format ?? (msg ? parseMeta(msg)?.params?.format : undefined)) ||
      DEFAULT_FORMATS[(artifactType === 'presentation' ? 'presentation' : artifactType === 'spreadsheet' ? 'spreadsheet' : 'document') as keyof typeof DEFAULT_FORMATS];
    if (!OFFICE_FORMATS.includes(format as any)) {
      return res.status(400).json({ ok: false, errorType: 'UNSUPPORTED_FORMAT', error: `不支持的格式 ${format}` });
    }

    const contentOverview = String(
      params?.contentOverview ??
      (msg ? parseMeta(msg)?.params?.contentOverview : undefined) ??
      (msg?.content || ''),
    ).trim() || 'Untitled';

    // 修改/转换既有文件时，先按 userId 校验源 artifact 归属（跨用户访问直接 404）
    const sourceArtifactId = typeof params?.sourceArtifactId === 'string' ? params.sourceArtifactId : undefined;
    let sourceArtifact: { id: string; version: number; conversationId: string | null; messageId: string | null } | null = null;
    if (sourceArtifactId) {
      sourceArtifact = await prisma.officeArtifact.findFirst({
        where: { id: sourceArtifactId, userId, status: 'completed' },
        select: { id: true, version: true, conversationId: true, messageId: true },
      });
      if (!sourceArtifact) return res.status(404).json({ ok: false, error: '源文件不存在或无权访问' });
    }

    const operation = typeof params?.operation === 'string' ? params.operation : 'generate';
    const targetRef = params?.targetRef && typeof params.targetRef === 'object' ? params.targetRef : undefined;

    const spec = {
      artifactType: artifactType === 'presentation' ? 'presentation' : artifactType === 'spreadsheet' ? 'spreadsheet' : 'document',
      format,
      contentOverview,
      title: typeof params?.title === 'string' ? params.title : undefined,
      audience: typeof params?.audience === 'string' ? params.audience : undefined,
      pageOrSlideCount: typeof params?.pageOrSlideCount === 'number' ? params.pageOrSlideCount : undefined,
      documentType: typeof params?.documentType === 'string' ? params.documentType : undefined,
      style: typeof params?.style === 'string' ? params.style : undefined,
      language: typeof params?.language === 'string' ? params.language : 'zh-CN',
      sourceArtifactId,
      // 修改语义随 spec 落库：渲染器当前不支持精确页级局部编辑，
      // 因此 modify 会以“基于源文件重新渲染”的方式生成新版本（不覆盖源文件）。
      operation,
      targetRef,
      conversationId: msg?.conversationId,
      sourceMessageId: msg?.id,
      userId,
    };

    const outcome = await runOfficeGeneration(spec as any, {
      userId,
      conversationId: msg?.conversationId ?? undefined,
      sourceMessageId: msg?.id ?? undefined,
      createArtifactRow: async (rec) => {
        const { prisma: p } = await import('../services/db');
        await p.officeArtifact.create({
          data: {
            userId,
            conversationId: msg?.conversationId ?? null,
            messageId: msg?.id ?? null,
            type: rec.type,
            format,
            mimeType: OFFICE_MIME[format as any],
            originalStorageRef: 'pending',
            specJson: JSON.stringify(rec.spec),
            filename: '',
            generationId: rec.artifactId,
            status: 'generating',
            dedupeKey: rec.artifactId,
            // 基于既有文件的修改：新版本挂在源版本之后，不覆盖源文件
            ...(sourceArtifact
              ? { parentVersion: sourceArtifact.version, version: sourceArtifact.version + 1 }
              : {}),
          },
        });
      },
      completeArtifact: async (artifactId, r) => {
        const { prisma: p } = await import('../services/db');
        await p.officeArtifact.update({
          where: { id: artifactId },
          data: {
            status: 'completed',
            originalStorageRef: r.originalRef,
            previewStorageRef: r.previewRef,
            previewStatus: r.previewStatus,
            checksum: r.checksum,
            size: r.size,
            pageCount: r.pageCount,
            filename: r.filename,
            mimeType: r.mimeType,
          },
        });
        // 版本链：新版本就绪后才把源文件标记为被取代（失败时源文件保持可用）
        if (sourceArtifact) {
          await p.officeArtifact.update({
            where: { id: sourceArtifact.id },
            data: { supersededBy: artifactId },
          }).catch(() => undefined);
        }
      },
      failArtifact: async (artifactId, reason) => {
        const { prisma: p } = await import('../services/db');
        await p.officeArtifact.update({
          where: { id: artifactId },
          data: { status: 'failed', failureReason: reason.slice(0, 300) },
        }).catch(() => undefined);
      },
    });

    if (!outcome.ok) {
      if (msg) {
        await prismaConversation.message.update({
          where: { id: msg.id },
          data: { metadata: JSON.stringify({ ...parseMeta(msg), status: 'failed', errorType: outcome.errorType, error: outcome.error }) },
        }).catch(() => undefined);
      }
      return res.json({ ok: false, errorType: outcome.errorType, error: outcome.error, artifactId: outcome.artifactId, latencyMs: outcome.latencyMs });
    }

    // Persist the result message + flip the confirm card to confirmed.
    let resultMsg: any = null;
    if (msg) {
      const art = await prisma.officeArtifact.findFirst({
        where: { id: outcome.artifactId },
      });
      resultMsg = await prismaConversation.message.create({
        data: {
          conversationId: msg.conversationId,
          role: 'assistant',
          content: art?.filename || `${outcome.artifactId}.${OFFICE_EXT[outcome.format]}`,
          messageType: 'office',
          model: 'office',
          metadata: JSON.stringify({
            artifactId: outcome.artifactId,
            type: spec.artifactType,
            format: outcome.format,
            mimeType: OFFICE_MIME[outcome.format],
            filename: art?.filename,
            size: outcome.size,
            pageCount: outcome.pageCount,
            checksum: outcome.checksum,
            previewStatus: outcome.previewStatus,
            previewRef: outcome.previewRef,
            status: 'done',
          }),
        },
      });
      await prismaConversation.message.update({
        where: { id: msg.id },
        data: { metadata: JSON.stringify({ ...parseMeta(msg), status: 'confirmed', resultMessageId: resultMsg.id }) },
      }).catch(() => undefined);

      // Context artifact event — "刚刚那个 PPT" resolves to this artifact.
      const { writeContextMemoryEvent } = await import('../services/contextMemory/runtime');
      await writeContextMemoryEvent(userId, msg.conversationId, {
        eventType: 'artifact_created',
        artifactType: spec.artifactType,
        artifactId: outcome.artifactId,
        messageId: resultMsg.id,
        model: 'office-planner',
        format: outcome.format,
        generationId: outcome.artifactId,
      }).catch(() => undefined);
    }

    return res.json({
      ok: true,
      kind: spec.artifactType,
      conversationId: msg?.conversationId,
      messageId: resultMsg?.id,
      artifactId: outcome.artifactId,
      format: outcome.format,
      pageCount: outcome.pageCount,
      checksum: outcome.checksum,
      size: outcome.size,
      previewStatus: outcome.previewStatus,
      downloadUrl: resultMsg ? `/api/chat/office/${resultMsg.id}/download` : null,
      previewUrl: resultMsg ? `/api/chat/office/${resultMsg.id}/preview` : null,
      latencyMs: outcome.latencyMs,
    });
  } catch (err: any) {
    console.error('Office generate error:', err);
    res.status(500).json({ ok: false, errorType: 'STORAGE_FAILED', error: String(err?.message ?? err) });
  }
});

// POST /api/chat/office/convert — deterministic format transformation.
// body: { sourceArtifactId, targetFormat } — re-renders the canonical
// spec into the new format. NO LLM call.
router.post('/convert', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { sourceArtifactId, targetFormat } = req.body || {};
    if (!sourceArtifactId || !targetFormat) {
      return res.status(400).json({ ok: false, error: '缺少 sourceArtifactId / targetFormat' });
    }

    const source = await prisma.officeArtifact.findFirst({
      where: { id: String(sourceArtifactId), userId, status: 'completed' },
    });
    if (!source) return res.status(404).json({ ok: false, error: '源文件不存在' });

    const targetFmt = String(targetFormat);
    if (!OFFICE_FORMATS.includes(targetFmt as any)) {
      return res.status(400).json({ ok: false, errorType: 'UNSUPPORTED_FORMAT', error: `不支持的目标格式 ${targetFmt}` });
    }

    const outcome = await transformOfficeArtifact(
      String(sourceArtifactId),
      targetFmt as OfficeFormat,
      {
        userId,
        conversationId: source.conversationId ?? undefined,
        sourceMessageId: source.messageId ?? undefined,
        createArtifactRow: async (rec) => {
          await prisma.officeArtifact.create({
            data: {
              userId,
              conversationId: source.conversationId ?? null,
              messageId: source.messageId ?? null,
              type: rec.type,
              format: String(targetFormat),
              mimeType: OFFICE_MIME[String(targetFormat) as any],
              originalStorageRef: 'pending',
              specJson: rec.spec ? JSON.stringify(rec.spec) : null,
              filename: '',
              generationId: rec.artifactId,
              status: 'generating',
              dedupeKey: rec.artifactId,
              parentVersion: source.version,
              version: source.version + 1,
            },
          });
        },
        completeArtifact: async (artifactId, r) => {
          await prisma.officeArtifact.update({
            where: { id: artifactId },
            data: {
              status: 'completed',
              originalStorageRef: r.originalRef,
              previewStorageRef: r.previewRef,
              previewStatus: r.previewStatus,
              checksum: r.checksum,
              size: r.size,
              pageCount: r.pageCount,
              filename: r.filename,
              mimeType: r.mimeType,
              // Link the version chain: supersede the source.
            },
          });
          await prisma.officeArtifact.update({
            where: { id: sourceArtifactId },
            data: { supersededBy: artifactId },
          }).catch(() => undefined);
        },
        failArtifact: async (artifactId, reason) => {
          await prisma.officeArtifact.update({
            where: { id: artifactId },
            data: { status: 'failed', failureReason: reason.slice(0, 300) },
          }).catch(() => undefined);
        },
      },
    );

    if (!outcome.ok) {
      return res.json({ ok: false, errorType: outcome.errorType, error: outcome.error });
    }

    const resultMsg = source.conversationId
      ? await prismaConversation.message.create({
        data: {
          conversationId: source.conversationId,
          role: 'assistant',
          content: `converted from ${sourceArtifactId}`,
          messageType: 'office',
          model: 'office-convert',
          metadata: JSON.stringify({
            artifactId: outcome.artifactId,
            sourceArtifactId,
            format: outcome.format,
            status: 'done',
          }),
        },
      })
      : null;

    return res.json({
      ok: true,
      artifactId: outcome.artifactId,
      sourceArtifactId,
      format: outcome.format,
      downloadUrl: resultMsg ? `/api/chat/office/${resultMsg.id}/download` : null,
    });
  } catch (err: any) {
    console.error('Office convert error:', err);
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// GET /api/chat/office/:messageId/download — serve the ORIGINAL file.
// The downloaded bytes ARE the user-requested format; the preview is
// never substituted, and nothing is zipped.
router.get('/:messageId/download', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const msg = await prismaConversation.message.findFirst({
      where: { id: String(req.params.messageId), conversation: { userId: req.user!.id } },
    });
    if (!msg) return res.status(404).json({ error: '消息不存在' });
    const meta = parseMeta(msg) || {};
    const artifactId = meta.artifactId;
    if (!artifactId) return res.status(404).json({ error: '该消息不是文件产物' });

    const art = await prisma.officeArtifact.findFirst({
      where: { id: artifactId, userId: req.user!.id },
    });
    if (!art) return res.status(404).json({ error: '文件不存在' });
    if (art.status !== 'completed') {
      return res.status(503).json({ ok: false, errorType: 'RENDER_FAILED', error: '文件尚未生成完成' });
    }

    const bytes = await loadOfficeFile(art.originalStorageRef);
    if (!bytes) return res.status(410).json({ error: '原始文件已不可用（预览失败不影响下载可用性判定）' });

    const fmt = (art.format || 'office') as keyof typeof OFFICE_EXT;
    res.setHeader('Content-Type', OFFICE_MIME[fmt] || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${art.filename || `${art.id}.${OFFICE_EXT[fmt] || 'bin'}`}"`,
    );
    res.setHeader('Content-Length', String(bytes.length));
    res.send(bytes);
  } catch (err: any) {
    console.error('Office download error:', err);
    res.status(500).json({ error: '下载失败' });
  }
});

// GET /api/chat/office/:messageId/preview — serve the derived preview.
// Preview failure NEVER affects the original (the download route is
// independent). This returns the preview representation for the browser.
router.get('/:messageId/preview', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const msg = await prismaConversation.message.findFirst({
      where: { id: String(req.params.messageId), conversation: { userId: req.user!.id } },
    });
    if (!msg) return res.status(404).json({ error: '消息不存在' });
    const meta = parseMeta(msg) || {};
    const artifactId = meta.artifactId;
    if (!artifactId) return res.status(404).json({ error: '该消息不是文件产物' });

    const art = await prisma.officeArtifact.findFirst({
      where: { id: artifactId, userId: req.user!.id },
    });
    if (!art) return res.status(404).json({ error: '文件不存在' });

    // If preview is cached on disk, serve it.
    if (art.previewStorageRef) {
      const pbytes = await loadOfficeFile(art.previewStorageRef);
      if (pbytes) {
        res.setHeader('Content-Type', 'application/json');
        return res.send(pbytes);
      }
    }
    // Re-generate deterministically from the spec (no AI).
    try {
      const spec = JSON.parse(art.specJson || '{}');
      const { buildPreviewForSpec } = await import('../services/office/previewRuntime');
      const preview = buildPreviewForSpec(spec, art.format);
      res.setHeader('Content-Type', 'application/json');
      return res.send(Buffer.from(JSON.stringify(preview)));
    } catch {
      return res.status(503).json({ ok: false, errorType: 'PREVIEW_FAILED', error: '预览不可用，请下载原始文件' });
    }
  } catch (err: any) {
    console.error('Office preview error:', err);
    res.status(500).json({ error: '预览失败' });
  }
});

export default router;
