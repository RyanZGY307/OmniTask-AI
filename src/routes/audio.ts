// ================================================================
// Audio Generation Route — /api/chat/audio/*
//
// POST /api/chat/audio/generate
//   body: AudioGenerationSpec { model, format, voiceDesign,
//         contentOverview, spokenText, voiceReferenceId, voiceId,
//         styleInstruction, conversationId, sourceMessageId }
//   → runAudioGeneration (validate → adapter → provider → decode →
//     validate → persist AudioArtifact → playback representation)
//   → record `artifact_created` Context Memory event
//   → create a messageType='audio' Message so the artifact survives
//     page refresh (player + download re-render from the message row)
//
// GET /api/chat/audio/:messageId/playback  → stream the browser-playable
// GET /api/chat/audio/:messageId/download  → stream the ORIGINAL file
//
// Provider details are NEVER handled here — this route only submits
// the standardized spec to the runtime. No model-list is maintained
// here; it comes from the TTS capability registry.
// ================================================================

import { Router, Response } from 'express';
import { prisma, prismaConversation } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { checkDailyLimit } from '../services/credits';
import { runAudioGeneration, audioConcurrencyGuard, type AudioGenerationSpec, AudioGenerationError } from '../services/audio/runtime';
import { TTS_MODELS } from '../services/audio/ttsRegistry';
import { writeContextMemoryEvent } from '../services/contextMemory/runtime';
import {
  storeAudioFile,
  storeAudioPlayback,
  loadAudioFile,
  loadVoiceReferenceBuffer,
} from '../services/audio/storage';

const router = Router();

// 该 route 是 TTS 生成 + 模型/格式清单 的便捷入口（/api/chat/audio）。
// 规格卡确认走 POST /api/chat/media/audio-generate（media.ts），
// 与图片/视频共享 media_confirm 卡片系统。
router.get('/models', authMiddleware, (_req: AuthRequest, res: Response) => {
  res.json({
    models: TTS_MODELS.map((m) => ({
      modelId: m.modelId,
      provider: m.provider,
      displayName: m.displayName,
      generationCapability: m.generationCapability,
      supportedFormats: m.supportedFormats,
      supportsVoiceDesign: m.supportsVoiceDesign,
      supportsVoiceClone: m.supportsVoiceClone,
      supportsStyleInstruction: m.supportsStyleInstruction,
      defaultFormat: m.defaultFormat,
      requiresVoiceReference: m.requiresVoiceReference,
    })),
  });
});

// ==================== Generate ====================

router.post('/generate', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const spec: AudioGenerationSpec = {
    model: String(req.body?.model ?? ''),
    format: String(req.body?.format ?? 'wav') as any,
    voiceDesign: typeof req.body?.voiceDesign === 'string' ? req.body.voiceDesign : undefined,
    contentOverview: typeof req.body?.contentOverview === 'string' ? req.body.contentOverview : undefined,
    spokenText: typeof req.body?.spokenText === 'string' ? req.body.spokenText : undefined,
    voiceReferenceId: typeof req.body?.voiceReferenceId === 'string' ? req.body.voiceReferenceId : undefined,
    voiceId: typeof req.body?.voiceId === 'string' ? req.body.voiceId : undefined,
    styleInstruction: typeof req.body?.styleInstruction === 'string' ? req.body.styleInstruction : undefined,
    conversationId: typeof req.body?.conversationId === 'string' ? req.body.conversationId : undefined,
    sourceMessageId: typeof req.body?.sourceMessageId === 'string' ? req.body.sourceMessageId : undefined,
    userId,
  };

  try {
    // Product-unlimited (Free AND Pro), but the technical guard still
    // caps per-user + global concurrency (spec §14). checkDailyLimit
    // short-circuits to allowed for audio_generation (Infinity table).
    const limit = await checkDailyLimit(userId, 'audio_generation').catch(() => ({ allowed: true } as any));
    if (!limit.allowed) return res.status(429).json({ ok: false, errorType: 'RATE_LIMITED', error: 'audio generation rate limited' });

    await audioConcurrencyGuard.acquire(userId);
    try {
      const outcome = await runAudioGeneration(spec, {
        persistArtifact: async (artifact, bytes) => {
          const refs = await storeAudioFile(userId, artifact, bytes);
          return refs;
        },
        storePlayback: async (uid, artifactId, bytes) => {
          return storeAudioPlayback(uid, artifactId, bytes);
        },
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
              voiceId: spec.voiceId ?? null,
              dedupeKey: record.generationId,
            },
          });
        },
      });

      if (!outcome.ok || !outcome.artifact) {
        // Mirror the failure onto the pre-created 'generating' row (when
        // one exists). MISSING_VOICE_REFERENCE / INVALID_REQUEST fail
        // before the row is created, so no row to mark.
        const et = outcome.errorType;
        if (et && et !== 'MISSING_VOICE_REFERENCE' && et !== 'INVALID_REQUEST' && outcome.artifact) {
          await prisma.audioArtifact.update({
            where: { id: outcome.artifact.artifactId },
            data: { status: 'failed', failureReason: `${et}: ${outcome.error ?? ''}`.slice(0, 300) },
          }).catch(() => undefined);
        }
        return res.json({ ok: false, errorType: outcome.errorType, error: outcome.error, latencyMs: outcome.latencyMs });
      }

      const art = outcome.artifact;

      // Persist an 'audio' message (survives refresh) + flip the
      // artifact row to completed with the real storage refs.
      const resultMsg = await prismaConversation.message.create({
        data: {
          conversationId: spec.conversationId ?? undefined as any,
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
      }).catch(() => null);

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

      // Context artifact event: next turn "刚刚那个" resolves to this.
      if (resultMsg) {
        await writeContextMemoryEvent(userId, spec.conversationId ?? 'new', {
          eventType: 'artifact_created',
          artifactType: 'audio',
          artifactId: art.artifactId,
          messageId: resultMsg.id,
          model: art.model,
          format: art.format,
          generationId: art.generationId,
        }).catch(() => undefined);
      }

      return res.json({
        ok: true,
        artifact: {
          artifactId: art.artifactId,
          provider: art.provider,
          model: art.model,
          format: art.format,
          mimeType: art.mimeType,
          playbackMime: art.playbackStorageRef ? 'audio/wav' : art.mimeType,
          size: art.size,
          duration: art.duration,
          messageId: resultMsg?.id ?? null,
          generationId: art.generationId,
          hasPlayback: !!art.playbackStorageRef,
        },
        messageId: resultMsg?.id ?? null,
        selectedModel: outcome.selectedModel,
        actualModel: outcome.actualModel,
        providerRequestId: outcome.providerRequestId,
        latencyMs: outcome.latencyMs,
      });
    } finally {
      audioConcurrencyGuard.release(userId);
    }
  } catch (err: any) {
    if (err instanceof AudioGenerationError) {
      return res.json({ ok: false, errorType: err.errorType, error: err.message });
    }
    console.error('Audio generation error:', err);
    res.status(500).json({ ok: false, errorType: 'STORAGE_ERROR', error: String(err?.message ?? err) });
  }
});

// ==================== Playback (browser-compatible) ====================

router.get('/:messageId/playback', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const msg = await prismaConversation.message.findFirst({
      where: { id: String(req.params.messageId), conversation: { userId }, messageType: 'audio' },
    });
    if (!msg) return res.status(404).json({ error: 'audio message not found' });
    const meta = safeParseMeta(msg);
    if (meta?.status !== 'done' || !meta.artifactId) {
      return res.status(409).json({ ok: false, errorType: 'AUDIO_NOT_READY', error: meta?.status ?? 'unknown', status: meta?.status });
    }
    const art = await prisma.audioArtifact.findUnique({ where: { id: meta.artifactId } });
    if (!art || art.status !== 'completed') {
      return res.status(409).json({ ok: false, errorType: 'AUDIO_NOT_READY', error: 'artifact not completed' });
    }
    // Player always streams the PLAYBACK representation when one
    // exists (raw encodings), otherwise the original (already playable).
    const ref = art.playbackStorageRef || art.originalStorageRef;
    const bytes = await loadAudioFile(userId, ref, art.playbackStorageRef ? 'audio/wav' : art.mimeType);
    if (!bytes) return res.status(404).json({ error: 'audio bytes missing' });
    const mime = art.playbackStorageRef ? 'audio/wav' : (art.mimeType || 'audio/wav');
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.send(bytes);
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ==================== Download (ORIGINAL user-selected format) ====================

router.get('/:messageId/download', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const msg = await prismaConversation.message.findFirst({
      where: { id: String(req.params.messageId), conversation: { userId }, messageType: 'audio' },
    });
    if (!msg) return res.status(404).json({ error: 'audio message not found' });
    const meta = safeParseMeta(msg);
    if (meta?.status !== 'done' || !meta.artifactId) return res.status(409).json({ ok: false, errorType: 'AUDIO_NOT_READY' });
    const art = await prisma.audioArtifact.findUnique({ where: { id: meta.artifactId } });
    if (!art || art.status !== 'completed') return res.status(409).json({ ok: false, errorType: 'AUDIO_NOT_READY' });

    // Download ALWAYS the original generated file, never the playback
    // representation (spec §6).
    const bytes = await loadAudioFile(userId, art.originalStorageRef, art.mimeType);
    if (!bytes) return res.status(404).json({ error: 'original audio bytes missing' });
    res.setHeader('Content-Type', art.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${art.filename}"`);
    res.send(bytes);
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ==================== helpers ====================

function safeParseMeta(msg: any): any {
  try {
    if (typeof msg?.metadata === 'object') return msg.metadata;
    return msg?.metadata ? JSON.parse(msg.metadata) : null;
  } catch {
    return null;
  }
}

export default router;
