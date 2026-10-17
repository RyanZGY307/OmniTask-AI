// ================================================================
// Audio file storage — original + playback representation.
//
// Files live under the user's media directory. The ORIGINAL file
// (user-selected format) and the PLAYBACK representation (browser-
// compatible WAV for raw encodings) are stored side by side. The DB
// keeps only the storage ref + metadata — never the base64 blob.
//
// Paths are derived from (userId, artifactId, kind) so refresh +
// re-entry always resolve the same file.
// ================================================================

import { promises as fs } from 'fs';
import * as path from 'path';
import type { AudioArtifactRecord } from './runtime';

function mediaRoot(): string {
  return process.env.CORTEX_MEDIA_DIR || path.join(process.cwd(), 'media');
}

function audioDir(userId: string): string {
  return path.join(mediaRoot(), 'audio', userId);
}

function originalPath(userId: string, artifactId: string, ext: string): string {
  return path.join(audioDir(userId), `${artifactId}-original.${ext}`);
}

function playbackPath(userId: string, artifactId: string): string {
  return path.join(audioDir(userId), `${artifactId}-playback.wav`);
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

// Persist the original bytes (+ optional playback bytes in one call).
// Returns the storage refs recorded on the artifact.
export async function storeAudioFile(
  userId: string,
  artifact: AudioArtifactRecord,
  originalBytes: Buffer,
): Promise<{ originalRef: string; playbackRef: string | null }> {
  await ensureDir(audioDir(userId));
  const ext = extFromMime(artifact.mimeType, artifact.format);
  const oref = originalPath(userId, artifact.artifactId, ext);
  await fs.writeFile(oref, originalBytes);
  return { originalRef: oref, playbackRef: null };
}

// Persist a separately-generated playback representation.
export async function storeAudioPlayback(
  userId: string,
  artifactId: string,
  playbackBytes: Buffer,
): Promise<string> {
  await ensureDir(audioDir(userId));
  const p = playbackPath(userId, artifactId);
  await fs.writeFile(p, playbackBytes);
  return p;
}

// Load audio bytes by storage ref. Returns null if the file is gone.
export async function loadAudioFile(userId: string, ref: string, _mime: string): Promise<Buffer | null> {
  try {
    // ref is either an absolute path (new) or "media/audio/..." (legacy).
    const p = path.isAbsolute(ref) ? ref : path.join(process.cwd(), ref);
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

// Resolve a VoiceReference record to its audio buffer (for voice-clone).
// The reference points at a FileRecord / storage ref — never a huge
// base64 DB column.
export async function loadVoiceReferenceBuffer(userId: string, voiceReferenceId: string): Promise<Buffer | null> {
  // VoiceReference rows are written by the upload handler; this is the
  // read side consumed by the MiMo VoiceClone adapter on demand.
  const { prisma } = await import('../db');
  const ref = await prisma.voiceReference.findFirst({
    where: { userId, id: voiceReferenceId },
  });
  if (!ref?.artifactId) return null;
  // The artifactId points at a stored audio file (originalRef).
  const art = await prisma.audioArtifact.findFirst({
    where: { userId, id: ref.artifactId, status: 'completed' },
  });
  if (!art) return null;
  return loadAudioFile(userId, art.originalStorageRef, art.mimeType);
}

function extFromMime(mime: string, format: string): string {
  if (mime === 'audio/wav') return 'wav';
  if (mime === 'audio/mpeg') return 'mp3';
  return format || 'bin';
}
