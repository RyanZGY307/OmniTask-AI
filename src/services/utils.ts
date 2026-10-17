import { prisma, prismaConversation } from './db';

export function sanitizeInput(input: string): string {
  return input.replace(/<[^>]*>/g, '').trim();
}

// Bounded-concurrency map (the only new concurrency primitive in the system).
// Runs `fn` over `items` with at most `limit` in flight at once, preserving
// input order in the result array. Items that reject produce `null` at their
// index so a single failure never aborts the batch. Callers never use
// Promise.all(N-thousands) — this pool is the gate that keeps fan-out
// bounded under the global cap.
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R | null> | R | null,
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let cursor = 0;
  const effectiveLimit = Math.max(1, limit);
  const runners = Array.from({ length: Math.min(effectiveLimit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) break;
      try {
        results[index] = await fn(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

export async function exportUserData(userId: string): Promise<any> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const conversations = await prismaConversation.conversation.findMany({
    where: { userId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  const memories = await prisma.memoryEntry.findMany({ where: { userId } });
  const transactions = await prisma.creditTransaction.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });

  return {
    exportDate: new Date().toISOString(),
    user: { email: user?.email, username: user?.username, createdAt: user?.createdAt },
    conversations: conversations.map(c => ({
      title: c.title,
      createdAt: c.createdAt,
      messages: c.messages.map(m => ({ role: m.role, content: m.content, model: m.model, createdAt: m.createdAt })),
    })),
    memories,
    transactions,
  };
}