import { prisma } from './db';

export async function getMemories(userId: string): Promise<any[]> {
  try {
    return prisma.memoryEntry.findMany({
      where: { userId, isActive: true },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });
  } catch {
    return [];
  }
}

export async function addMemory(userId: string, content: string, category: string, level?: number): Promise<any> {
  return prisma.memoryEntry.create({
    data: { userId, content, category: category || 'general', level: level || 1 },
  });
}

export async function updateMemory(id: string, data: any): Promise<any> {
  return prisma.memoryEntry.update({ where: { id }, data });
}

export async function getLongTermMemories(userId: string, type?: string, limit = 20): Promise<any[]> {
  try {
    const where: any = { userId, status: { in: ['active', 'reinforced'] } };
    if (type) where.type = type;
    return prisma.longTermMemory.findMany({
      where,
      orderBy: { importance: 'desc' },
      take: limit,
    });
  } catch { return []; }
}

export async function deleteLongTermMemory(id: string): Promise<void> {
  await prisma.longTermMemory.update({ where: { id }, data: { status: 'deleted', deletedAt: new Date() } });
  await prisma.memoryEvent.create({ data: { memoryId: id, eventType: 'deleted', detail: 'User requested deletion' } }).catch(() => {});
}

export async function getUserProfile(userId: string): Promise<any> {
  return prisma.userProfile.findUnique({ where: { userId } });
}
