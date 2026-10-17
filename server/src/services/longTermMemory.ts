// ================================================================
// Long-Term Memory — Unified CRUD for LongTermMemory table
// ================================================================

import { prisma } from './db';

export interface CreateMemoryInput {
  userId: string;
  type: string;
  subtype?: string;
  content: string;
  structuredData?: any;
  status?: string;
  confidence?: number;
  importance?: number;
  sourceType?: string;
  sourceId?: string;
  sourceVersion?: number;
  domain?: string;
  conversationId?: string;
  fileId?: string;
  supersedes?: string;
  expiresAt?: Date;
}

export async function createLongTermMemory(input: CreateMemoryInput): Promise<any> {
  const mem = await prisma.longTermMemory.create({
    data: {
      userId: input.userId,
      type: input.type,
      subtype: input.subtype,
      content: input.content,
      structuredData: input.structuredData,
      status: input.status || 'active',
      confidence: input.confidence ?? 0.5,
      importance: input.importance ?? 0.5,
      stability: 0.5,
      freshness: 1.0,
      evidenceCount: 1,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      domain: input.domain,
      conversationId: input.conversationId,
      fileId: input.fileId,
      supersedes: input.supersedes,
      expiresAt: input.expiresAt,
    },
  });

  // Log creation event
  await prisma.memoryEvent.create({
    data: { memoryId: mem.id, eventType: 'created', detail: `Type: ${input.type}` },
  }).catch(() => {});

  return mem;
}

export async function reinforceMemory(memoryId: string): Promise<void> {
  const mem = await prisma.longTermMemory.findUnique({ where: { id: memoryId } });
  if (!mem) return;

  const newCount = mem.evidenceCount + 1;
  const newConfidence = Math.min(0.99, mem.confidence + 0.03);
  const newStatus = newCount >= 10 && newConfidence >= 0.8 ? 'reinforced' : mem.status;

  await prisma.longTermMemory.update({
    where: { id: memoryId },
    data: {
      evidenceCount: newCount,
      confidence: newConfidence,
      stability: Math.min(1, mem.stability + 0.02),
      freshness: 1.0,
      status: newStatus,
      lastObservedAt: new Date(),
      lastConfirmedAt: new Date(),
    },
  });

  await prisma.memoryEvent.create({
    data: { memoryId, eventType: 'evidence_added', detail: `Count: ${newCount}` },
  }).catch(() => {});
}

export async function supersedeMemory(oldId: string, newContent: string, userId: string): Promise<string> {
  const newMem = await createLongTermMemory({
    userId,
    type: 'conversation_fact',
    content: newContent,
    supersedes: oldId,
    confidence: 0.7,
  });

  await prisma.longTermMemory.update({
    where: { id: oldId },
    data: { status: 'superseded', supersededBy: newMem.id },
  });

  await prisma.memoryEvent.create({
    data: { memoryId: oldId, eventType: 'superseded', detail: `Replaced by ${newMem.id}` },
  }).catch(() => {});

  return newMem.id;
}

export async function getRelevantLongTermMemories(
  userId: string,
  query: string,
  conversationId?: string,
  limit = 10,
): Promise<any[]> {
  try {
    // 1. Conversation-specific memories
    const convMemories = conversationId
      ? await prisma.longTermMemory.findMany({
          where: { userId, conversationId, status: { in: ['active', 'reinforced'] } },
          orderBy: { importance: 'desc' },
          take: 5,
        })
      : [];

    // 2. Keyword search across all active memories
    const keywords = extractKeywords(query);
    const keywordMemories = keywords.length > 0
      ? await prisma.longTermMemory.findMany({
          where: {
            userId,
            status: { in: ['active', 'reinforced'] },
            OR: keywords.slice(0, 10).map(k => ({ content: { contains: k } })),
          },
          orderBy: { importance: 'desc' },
          take: limit,
        })
      : [];

    // 3. High-importance memories (user requirements, strong preferences)
    const importantMemories = await prisma.longTermMemory.findMany({
      where: {
        userId,
        status: { in: ['active', 'reinforced'] },
        importance: { gte: 0.8 },
      },
      orderBy: { importance: 'desc' },
      take: 5,
    });

    // Deduplicate
    const seen = new Set<string>();
    const results: any[] = [];
    for (const m of [...convMemories, ...importantMemories, ...keywordMemories]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        results.push(m);
        // Update lastUsedAt
        prisma.longTermMemory.update({ where: { id: m.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
      }
    }

    return results.slice(0, limit);
  } catch {
    return [];
  }
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '与',
    '对', '把', '被', '让', '用', '从', '到', '吗', '呢', '吧', '啊', '嗯', '哦',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had',
    'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'may', 'might', 'can', 'could',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
    'my', 'your', 'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those',
    'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
    'how', 'what', 'when', 'where', 'why', 'which', 'who',
  ]);

  return [...new Set(
    text.split(/[\s,，。.!！?？;；:：\n\t（）()""''「」]+/)
      .map(w => w.trim().toLowerCase())
      .filter(w => w.length >= 2 && !stopWords.has(w)),
  )].slice(0, 20);
}