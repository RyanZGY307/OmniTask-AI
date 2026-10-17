// ================================================================
// Dynamic Taxonomy — AI creates knowledge categories on demand
// ================================================================

import { prismaKnowledge } from './db';

export async function findCategoryByName(name: string): Promise<any | null> {
  const normalized = String(name ?? '').trim();
  if (!normalized) return null;
  return prismaKnowledge.knowledgeCategory.findFirst({
    where: { name: normalized },
  });
}

export async function createCategory(
  name: string,
  description?: string,
  parentId?: string,
): Promise<any> {
  return prismaKnowledge.knowledgeCategory.create({
    data: {
      name: String(name ?? '').trim(),
      description: description?.trim() ? description.trim() : null,
      parentId: parentId || null,
      aiCreated: true,
    },
  });
}

export async function findOrCreateCategory(
  name: string,
  description?: string,
  parentId?: string,
): Promise<any> {
  const found = await findCategoryByName(name);
  if (found) return found;
  try {
    return await createCategory(name, description, parentId);
  } catch (err: any) {
    // Lost a race on the unique name; return the winner
    if (err?.code === 'P2002') {
      const retry = await findCategoryByName(name);
      if (retry) return retry;
    }
    throw err;
  }
}

export async function listCategories(parentId?: string): Promise<any[]> {
  return prismaKnowledge.knowledgeCategory.findMany({
    where: parentId ? { parentId } : undefined,
    orderBy: { name: 'asc' },
  });
}

export async function assignObjectToCategory(
  objectId: string,
  categoryId: string,
  primary?: boolean,
): Promise<void> {
  await prismaKnowledge.$transaction(async (tx) => {
    if (primary) {
      await tx.knowledgeObjectCategory.updateMany({
        where: { objectId, primary: true },
        data: { primary: false },
      });
      await tx.knowledgeObjectCategory.upsert({
        where: { objectId_categoryId: { objectId, categoryId } },
        update: { primary: true },
        create: { objectId, categoryId, primary: true },
      });
      return;
    }
    await tx.knowledgeObjectCategory.upsert({
      where: { objectId_categoryId: { objectId, categoryId } },
      update: { primary: false },
      create: { objectId, categoryId, primary: false },
    });
  });
}
