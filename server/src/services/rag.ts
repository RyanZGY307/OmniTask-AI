// ================================================================
// RAG — Retrieval from Knowledge DB
// ================================================================
// DocumentChunk lives in cortex_knowledge database.

import { prismaKnowledge } from './db';

export async function getRelevantChunks(query: string, userId?: string, limit = 5): Promise<string[]> {
  try {
    const chunks = await prismaKnowledge.documentChunk.findMany({
      where: {
        isActive: true,
        // 公共分片（userId 为空）人人可见；带归属的分片仅本人可见。
        // 缺省（未传 userId）时只看公共分片，避免越权召回。
        ...(userId ? { OR: [{ userId: null }, { userId }] } : { userId: null }),
        AND: [{
          OR: [
            { content: { contains: query.substring(0, 100) } },
            { title: { contains: query.substring(0, 100) } },
          ],
        }],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return chunks.map(c => `[${c.sourceType}] ${c.title || '文档'}: ${c.content.substring(0, 500)}`);
  } catch {
    return [];
  }
}

export async function semanticSearch(query: string, userId?: string, limit = 5): Promise<any[]> {
  return getRelevantChunks(query, userId, limit).then(chunks =>
    chunks.map((c, i) => ({ content: c, score: 1 - i * 0.1 }))
  );
}