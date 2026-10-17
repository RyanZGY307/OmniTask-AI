import { Router, Response } from 'express';
import { prisma, prismaConversation } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { checkDailyLimit, incrementDailyUsage } from '../services/credits';
import {
  generateImage, generateVideo, checkVideo,
  IMAGE_RATIOS, VIDEO_RATIOS, VIDEO_SECONDS, normalizeImageSize,
} from '../services/agnes';

const router = Router();

const IMAGE_MODELS = ['agnes-image-2.0-flash', 'agnes-image-2.1-flash', 'agnes-image-2.5-flash'];

function parseMeta(msg: any): any {
  try { return msg.metadata ? JSON.parse(msg.metadata) : null; } catch { return null; }
}

// POST /api/chat/media/confirm
// body: { confirmMessageId, params: { model, ratio, resolution, seconds, prompt } }
router.post('/confirm', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { confirmMessageId, params } = req.body || {};
    if (!confirmMessageId) return res.status(400).json({ error: '缺少 confirmMessageId' });

    const msg = await prismaConversation.message.findFirst({
      where: { id: String(confirmMessageId), conversation: { userId } },
    });
    if (!msg) return res.status(404).json({ error: '确认消息不存在' });
    const meta = parseMeta(msg);
    if (!meta || meta.status !== 'pending') {
      return res.status(409).json({ error: '该确认卡片已处理', media: meta });
    }

    const kind: 'image' | 'video' = meta.kind;
    const prompt = String(params?.prompt || meta.prompt || msg.content || '');
    if (!prompt) return res.status(400).json({ error: '缺少提示词' });

    // ===== 图片 =====
    if (kind === 'image') {
      const model = IMAGE_MODELS.includes(String(params?.model)) ? String(params.model) : 'agnes-image-2.5-flash';
      const ratio = params?.ratio && (IMAGE_RATIOS as readonly string[]).includes(String(params.ratio)) ? String(params.ratio) : undefined;
      const resolution = params?.resolution ? normalizeImageSize(String(params.resolution)) : '1K';
      const refImages: string[] = Array.isArray(meta.refImages) ? meta.refImages : [];

      let url = '';
      try {
        const r = await generateImage(prompt, { model, ratio, resolution, images: refImages });
        url = r.url;
      } catch (err: any) {
        await prismaConversation.message.update({
          where: { id: msg.id },
          data: { metadata: JSON.stringify({ ...meta, status: 'failed', error: err.message }) },
        });
        return res.status(502).json({ error: `图片生成失败: ${err.message}` });
      }

      const resultMsg = await prismaConversation.message.create({
        data: {
          conversationId: msg.conversationId,
          role: 'assistant',
          content: prompt,
          messageType: 'image',
          model,
          metadata: JSON.stringify({
            prompt, model, ratio, resolution,
            imageUrl: url, status: 'done',
            refCount: refImages.length,
          }),
        },
      });
      await prismaConversation.message.update({
        where: { id: msg.id },
        data: { metadata: JSON.stringify({ ...meta, status: 'confirmed', resultMessageId: resultMsg.id, params: { model, ratio, resolution } }) },
      });
      await prismaConversation.conversation.update({
        where: { id: msg.conversationId },
        data: { updatedAt: new Date() },
      });
      return res.json({ ok: true, kind: 'image', conversationId: msg.conversationId, messageId: resultMsg.id, imageUrl: url });
    }

    // ===== 视频 =====
    const model = 'agnes-video-2.5-flash';
    const seconds = VIDEO_SECONDS.includes(Number(params?.seconds) as any) ? Number(params.seconds) : 5;
    const ratio = params?.ratio && (VIDEO_RATIOS as readonly string[]).includes(String(params.ratio)) ? String(params.ratio) : '16:9';

    let taskId = '', videoId = '';
    try {
      const r = await generateVideo(prompt, { model, seconds, aspectRatio: ratio });
      taskId = r.taskId; videoId = r.videoId;
    } catch (err: any) {
      await prismaConversation.message.update({
        where: { id: msg.id },
        data: { metadata: JSON.stringify({ ...meta, status: 'failed', error: err.message }) },
      });
      return res.status(502).json({ error: `视频任务创建失败: ${err.message}` });
    }

    await incrementDailyUsage(userId, 'video').catch(() => {});

    const resultMsg = await prismaConversation.message.create({
      data: {
        conversationId: msg.conversationId,
        role: 'assistant',
        content: prompt,
        messageType: 'video',
        model,
        metadata: JSON.stringify({
          prompt, model, ratio, seconds,
          status: 'processing',
          taskId, videoId,
          videoUrl: null,
          createdAt: new Date().toISOString(),
        }),
      },
    });
    await prismaConversation.message.update({
      where: { id: msg.id },
      data: { metadata: JSON.stringify({ ...meta, status: 'confirmed', resultMessageId: resultMsg.id, params: { model, seconds, ratio } }) },
    });
    await prismaConversation.conversation.update({
      where: { id: msg.conversationId },
      data: { updatedAt: new Date() },
    });
    return res.json({ ok: true, kind: 'video', conversationId: msg.conversationId, messageId: resultMsg.id, taskId, videoId });
  } catch (err: any) {
    console.error('Media confirm error:', err);
    res.status(500).json({ error: '媒体确认处理失败' });
  }
});

// ==================== Audio generation confirm ====================
// kind === 'audio-gen': runs the Audio Generation Runtime synchronously
// (no model fallback, explicit error states), persists an AudioArtifact
// + 'audio' message, and returns the playback/download URLs.
router.post('/audio-generate', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { confirmMessageId, params } = req.body || {};
    if (!confirmMessageId) return res.status(400).json({ ok: false, error: '缺少 confirmMessageId' });

    const msg = await prismaConversation.message.findFirst({
      where: { id: String(confirmMessageId), conversation: { userId } },
    });
    if (!msg) return res.status(404).json({ ok: false, error: '确认消息不存在' });
    const meta = parseMeta(msg);
    if (!meta || meta.status !== 'pending' || meta.kind !== 'audio-gen') {
      return res.status(409).json({ ok: false, error: '该音频确认卡片已处理', media: meta });
    }

    const {
      runAudioGeneration,
      audioConcurrencyGuard,
    } = await import('../services/audio/runtime');
    const { storeAudioFile, storeAudioPlayback, loadVoiceReferenceBuffer } = await import('../services/audio/storage');

    await audioConcurrencyGuard.acquire(userId);
    try {
      const spec: any = {
        model: String(params?.model ?? meta.params?.model ?? 'mimo-v2.5-tts'),
        format: String(params?.format ?? meta.params?.format ?? 'wav') as any,
        voiceDesign: typeof params?.voiceDesign === 'string' ? params.voiceDesign : (typeof meta.params?.voiceDesign === 'string' ? meta.params.voiceDesign : undefined),
        contentOverview: typeof params?.contentOverview === 'string' ? params.contentOverview : (typeof meta.params?.contentOverview === 'string' ? meta.params.contentOverview : (String(meta.prompt || msg.content || ''))),
        spokenText: typeof params?.spokenText === 'string' ? params.spokenText : (typeof meta.params?.spokenText === 'string' ? meta.params.spokenText : undefined),
        styleInstruction: typeof params?.styleInstruction === 'string' ? params.styleInstruction : (typeof meta.params?.styleInstruction === 'string' ? meta.params.styleInstruction : undefined),
        voiceReferenceId: typeof params?.voiceReferenceId === 'string' ? params.voiceReferenceId : (typeof meta.params?.voiceReferenceId === 'string' ? meta.params.voiceReferenceId : undefined),
        voiceId: typeof params?.voiceId === 'string' ? params.voiceId : (typeof meta.params?.voiceId === 'string' ? meta.params.voiceId : undefined),
        conversationId: msg.conversationId,
        sourceMessageId: msg.id,
        userId,
      };

      const outcome = await runAudioGeneration(spec, {
        persistArtifact: async (artifact, bytes) => storeAudioFile(userId, artifact, bytes),
        storePlayback: async (uid, artifactId, bytes) => storeAudioPlayback(uid, artifactId, bytes),
        loadVoiceReference: (refId) => loadVoiceReferenceBuffer(userId, refId),
        createArtifactRow: async (record) => {
          await prisma.audioArtifact.create({
            data: {
              userId,
              conversationId: record.conversationId,
              messageId: record.messageId,
              provider: record.provider,
              model: record.model,
              format: record.format,
              mimeType: record.mimeType,
              originalStorageRef: 'pending',
              filename: record.filename,
              generationId: record.generationId,
              status: 'generating',
              selectedModel: record.metadata?.selectedModel ?? record.model,
              actualModel: record.metadata?.actualModel ?? record.model,
              voiceDesignPrompt: spec.voiceDesign ?? null,
              dedupeKey: record.generationId,
            },
          });
        },
      });

      if (!outcome.ok || !outcome.artifact) {
        // Mark the confirm card + (if a row was created) artifact as failed.
        await prismaConversation.message.update({
          where: { id: msg.id },
          data: { metadata: JSON.stringify({ ...meta, status: 'failed', error: outcome.errorType, errorDetail: outcome.error }) },
        }).catch(() => undefined);
        if (outcome.artifact && outcome.errorType !== 'MISSING_VOICE_REFERENCE' && outcome.errorType !== 'INVALID_REQUEST') {
          await prisma.audioArtifact.update({
            where: { id: outcome.artifact.artifactId },
            data: { status: 'failed', failureReason: `${outcome.errorType}: ${outcome.error ?? ''}`.slice(0, 300) },
          }).catch(() => undefined);
        }
        return res.json({ ok: false, errorType: outcome.errorType, error: outcome.error, latencyMs: outcome.latencyMs });
      }

      const art = outcome.artifact;
      const resultMsg = await prismaConversation.message.create({
        data: {
          conversationId: msg.conversationId,
          role: 'assistant',
          content: art.filename,
          messageType: 'audio',
          model: art.model,
          metadata: JSON.stringify({
            artifactId: art.artifactId,
            provider: art.provider,
            model: art.model,
            format: art.format,
            mimeType: art.mimeType,
            playbackMime: art.playbackStorageRef ? 'audio/wav' : art.mimeType,
            size: art.size,
            duration: art.duration,
            encoding: art.metadata.encoding,
            sampleRate: art.metadata.sampleRate,
            channels: art.metadata.channels,
            bitDepth: art.metadata.bitDepth,
            voiceId: art.metadata.voiceId,
            selectedModel: art.metadata.selectedModel,
            actualModel: art.metadata.actualModel,
            providerRequestId: art.metadata.providerRequestId,
            status: 'done',
          }),
        },
      });

      await prisma.audioArtifact.update({
        where: { id: art.artifactId },
        data: {
          status: 'completed',
          originalStorageRef: art.originalStorageRef,
          playbackStorageRef: art.playbackStorageRef ?? null,
          size: art.size,
          encoding: art.metadata.encoding ?? null,
          sampleRate: art.metadata.sampleRate ?? null,
          channels: art.metadata.channels ?? null,
          bitDepth: art.metadata.bitDepth ?? null,
          providerRequestId: art.metadata.providerRequestId ?? null,
          voiceId: art.metadata.voiceId ?? null,
        },
      }).catch(() => undefined);

      await prismaConversation.message.update({
        where: { id: msg.id },
        data: { metadata: JSON.stringify({ ...meta, status: 'confirmed', resultMessageId: resultMsg.id }) },
      }).catch(() => undefined);

      // Context artifact event — "刚刚那个" resolves to this audio artifact.
      const { writeContextMemoryEvent } = await import('../services/contextMemory/runtime');
      await writeContextMemoryEvent(userId, msg.conversationId, {
        eventType: 'artifact_created',
        artifactType: 'audio',
        artifactId: art.artifactId,
        messageId: resultMsg.id,
        model: art.model,
        format: art.format,
        generationId: art.generationId,
      }).catch(() => undefined);

      return res.json({
        ok: true,
        kind: 'audio',
        conversationId: msg.conversationId,
        messageId: resultMsg.id,
        artifactId: art.artifactId,
        playbackUrl: `/api/chat/audio/${resultMsg.id}/playback`,
        downloadUrl: `/api/chat/audio/${resultMsg.id}/download`,
        format: art.format,
        mimeType: art.mimeType,
        playbackMime: art.playbackStorageRef ? 'audio/wav' : art.mimeType,
        hasPlaybackRepresentation: !!art.playbackStorageRef,
        size: art.size,
        duration: art.duration,
        selectedModel: outcome.selectedModel,
        actualModel: outcome.actualModel,
        providerRequestId: outcome.providerRequestId,
        latencyMs: outcome.latencyMs,
      });
    } finally {
      audioConcurrencyGuard.release(userId);
    }
  } catch (err: any) {
    console.error('Audio generate error:', err);
    res.status(500).json({ ok: false, errorType: 'STORAGE_ERROR', error: String(err?.message ?? err) });
  }
});

// GET /api/chat/media/video/:messageId
router.get('/video/:messageId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const msg = await prismaConversation.message.findFirst({
      where: { id: String(req.params.messageId), conversation: { userId: req.user!.id } },
    });
    if (!msg) return res.status(404).json({ error: '消息不存在' });
    const meta = parseMeta(msg) || {};

    if (meta.status === 'done' || meta.videoUrl) {
      return res.json({ status: 'done', url: meta.videoUrl || null, progress: 100 });
    }
    if (!meta.videoId && !meta.taskId) {
      return res.json({ status: 'error', error: meta.error || '缺少任务ID' });
    }

    const r = await checkVideo(meta.videoId || meta.taskId, meta.model || 'agnes-video-2.5-flash');
    if (r.status === 'completed' && r.url) {
      await prismaConversation.message.update({
        where: { id: msg.id },
        data: { metadata: JSON.stringify({ ...meta, status: 'done', videoUrl: r.url }) },
      });
      return res.json({ status: 'done', url: r.url, progress: 100 });
    }
    if (r.status === 'failed' || r.status === 'error') {
      await prismaConversation.message.update({
        where: { id: msg.id },
        data: { metadata: JSON.stringify({ ...meta, status: 'failed', error: '视频生成失败' }) },
      });
      return res.json({ status: 'failed', error: '视频生成失败' });
    }
    return res.json({ status: 'processing', progress: r.progress ?? null });
  } catch (err: any) {
    console.error('Video poll error:', err);
    res.status(500).json({ error: '查询失败' });
  }
});

export default router;
