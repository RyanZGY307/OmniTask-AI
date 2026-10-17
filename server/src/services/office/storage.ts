// ================================================================
// Office file storage — original + preview separation.
//
// Mirrors the audio storage layout. The ORIGINAL file (user-requested
// format) is authoritative; the PREVIEW representation (HTML slide-
// prep, spreadsheet-viewer JSON, document outline) is derived,
// cacheable, and regenerable without re-running AI.
// ================================================================

import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

function mediaRoot(): string {
  return process.env.CORTEX_MEDIA_DIR || path.join(process.cwd(), 'media');
}

function officeDir(userId: string): string {
  return path.join(mediaRoot(), 'office', userId);
}

function originalPath(userId: string, artifactId: string, ext: string): string {
  return path.join(officeDir(userId), `${artifactId}-original.${ext}`);
}

function previewPath(userId: string, artifactId: string, ext: string): string {
  return path.join(officeDir(userId), `${artifactId}-preview.${ext}`);
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export interface OfficeStorageRefs {
  originalRef: string;
  previewRef: string | null;
  checksum: string;
}

// Persist the original bytes. Returns storage refs + SHA-256 checksum.
export async function storeOfficeFile(
  userId: string,
  artifactId: string,
  ext: string,
  originalBytes: Buffer,
): Promise<OfficeStorageRefs> {
  await ensureDir(officeDir(userId));
  const oref = originalPath(userId, artifactId, ext);
  await fs.writeFile(oref, originalBytes);
  const checksum = crypto.createHash('sha256').update(originalBytes).digest('hex');
  return { originalRef: oref, previewRef: null, checksum };
}

// Persist a preview representation.
export async function storeOfficePreview(
  userId: string,
  artifactId: string,
  previewBytes: Buffer,
  ext: string,
): Promise<string> {
  await ensureDir(officeDir(userId));
  const p = previewPath(userId, artifactId, ext);
  await fs.writeFile(p, previewBytes);
  return p;
}

// Load bytes by storage ref. Returns null if the file is gone.
export async function loadOfficeFile(ref: string): Promise<Buffer | null> {
  try {
    const p = path.isAbsolute(ref) ? ref : path.join(process.cwd(), ref);
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

export function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
