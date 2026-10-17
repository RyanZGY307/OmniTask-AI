// ================================================================
// File Memory — Upload, versioning, fact extraction, dependency
// ================================================================

import { prisma } from './db';
import crypto from 'crypto';

export async function registerFile(
  userId: string,
  data: { filename: string; content: string; mimeType?: string; conversationId?: string },
): Promise<any> {
  const hash = crypto.createHash('sha256').update(data.content).digest('hex').substring(0, 32);

  const file = await prisma.fileRecord.create({
    data: {
      userId,
      conversationId: data.conversationId,
      filename: data.filename,
      mimeType: data.mimeType,
      size: data.content.length,
      hash,
      version: 1,
    },
  });

  // Create first version
  await prisma.fileVersion.create({
    data: { fileId: file.id, version: 1, content: data.content, hash },
  });

  return file;
}

export async function addFileVersion(
  fileId: string,
  content: string,
): Promise<any> {
  const file = await prisma.fileRecord.findUnique({ where: { id: fileId } });
  if (!file) throw new Error('File not found');

  const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 32);
  const newVersion = file.version + 1;

  const version = await prisma.fileVersion.create({
    data: { fileId, version: newVersion, content, hash },
  });

  await prisma.fileRecord.update({
    where: { id: fileId },
    data: { version: newVersion, hash },
  });

  // Invalidate old facts
  await prisma.fileFact.updateMany({
    where: { fileId, status: 'active', version: { lt: newVersion } },
    data: { status: 'stale' },
  });

  return version;
}

export async function extractFacts(fileId: string, content: string, version: number): Promise<void> {
  // Simple fact extraction — split into meaningful chunks
  const lines = content.split('\n').filter(l => l.trim().length > 10);

  // Extract headers (lines starting with #)
  const headers = lines.filter(l => /^#{1,3}\s/.test(l)).map(l => l.replace(/^#+\s*/, ''));
  for (const h of headers.slice(0, 10)) {
    await prisma.fileFact.create({
      data: { fileId, version, factType: 'entity', content: h, confidence: 0.9 },
    }).catch(() => {});
  }

  // Extract numbered/bulleted items (likely important facts)
  const items = lines.filter(l => /^\d+[\.\)]\s|^[-*]\s/.test(l));
  for (const item of items.slice(0, 20)) {
    await prisma.fileFact.create({
      data: { fileId, version, factType: 'source_fact', content: item.replace(/^\d+[\.\)]\s|^[-*]\s/, ''), confidence: 0.8 },
    }).catch(() => {});
  }

  // Extract lines with numbers (likely data/measurements)
  const dataLines = lines.filter(l => /\d+\.?\d*/.test(l) && l.length < 200);
  for (const dl of dataLines.slice(0, 10)) {
    await prisma.fileFact.create({
      data: { fileId, version, factType: 'extracted_fact', content: dl.trim(), confidence: 0.7 },
    }).catch(() => {});
  }

  // Create summary fact
  const summary = content.substring(0, 500);
  await prisma.fileFact.create({
    data: { fileId, version, factType: 'summary', content: summary, confidence: 1.0 },
  }).catch(() => {});
}

export async function getFileFacts(fileId: string, status = 'active'): Promise<any[]> {
  return prisma.fileFact.findMany({ where: { fileId, status }, orderBy: { confidence: 'desc' } });
}

export async function getFileVersions(fileId: string): Promise<any[]> {
  return prisma.fileVersion.findMany({ where: { fileId }, orderBy: { version: 'desc' } });
}

export async function invalidateDependents(fileId: string): Promise<void> {
  // Mark dependent long-term memories as stale
  await prisma.longTermMemory.updateMany({
    where: { fileId, status: { in: ['active', 'reinforced'] } },
    data: { status: 'stale', freshness: 0 },
  });
}

export async function getRelevantFiles(userId: string, conversationId?: string, limit = 5): Promise<any[]> {
  try {
    const where: any = { userId, status: 'active' };
    if (conversationId) where.conversationId = conversationId;
    return prisma.fileRecord.findMany({
      where,
      include: { facts: { where: { status: 'active' }, take: 10 } },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
  } catch { return []; }
}

export async function deleteFile(fileId: string): Promise<void> {
  await prisma.fileRecord.update({ where: { id: fileId }, data: { status: 'deleted' } });
  await invalidateDependents(fileId);
}