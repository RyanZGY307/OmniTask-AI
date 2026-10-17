// ================================================================
// Prompt Registry — CRUD + version management for Prompt Atoms
// ================================================================

import { prismaKnowledge } from './db';

export type AtomStatus = 'draft' | 'validated' | 'published' | 'disabled' | 'archived';
export type AtomCategory = 'core' | 'task' | 'research' | 'knowledge' | 'verification' | 'output' | 'scenario' | 'domain' | 'skill' | 'agent';

export interface PromptAtomInput {
  id: string;
  category: AtomCategory;
  purpose: string;
  priority: number;
  requires?: string[];
  conflicts_with?: string[];
  compatible_with?: string[];
  conditions?: Record<string, any>;
  parent?: string | null;
  extends?: string[];
  override?: string | null;
  status?: AtomStatus;
  version?: string;
  tags?: string[];
  deprecated_by?: string | null;
}

export interface AtomVersionInput {
  atomId: string;
  version: string;
  instruction: string;
  metadata?: Record<string, any>;
  created_by?: string | null;
}

export async function upsertAtom(input: PromptAtomInput): Promise<{ id: string; status: string }> {
  const { requires = [], conflicts_with = [], compatible_with = [], extends: extends_ = [], tags = [] } = input;
  const result = await prismaKnowledge.promptAtom.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      category: input.category,
      purpose: input.purpose,
      priority: input.priority,
      requires: JSON.stringify(requires),
      conflicts_with: JSON.stringify(conflicts_with),
      compatible_with: JSON.stringify(compatible_with),
      conditions: input.conditions ? JSON.stringify(input.conditions) : undefined,
      parent: input.parent,
      extends: JSON.stringify(extends_),
      override: input.override,
      status: input.status || 'draft',
      version: input.version || '1.0.0',
      tags: JSON.stringify(tags),
      deprecated_by: input.deprecated_by,
    },
    update: {
      category: input.category,
      purpose: input.purpose,
      priority: input.priority,
      requires: JSON.stringify(requires),
      conflicts_with: JSON.stringify(conflicts_with),
      compatible_with: JSON.stringify(compatible_with),
      conditions: input.conditions ? JSON.stringify(input.conditions) : undefined,
      parent: input.parent,
      extends: JSON.stringify(extends_),
      override: input.override,
      status: input.status || undefined,
      version: input.version || undefined,
      tags: JSON.stringify(tags),
      deprecated_by: input.deprecated_by,
    },
  });
  return { id: result.id, status: result.status };
}

export async function createAtomVersion(input: AtomVersionInput): Promise<string> {
  const version = await prismaKnowledge.promptAtomVersion.create({
    data: {
      atomId: input.atomId,
      version: input.version,
      instruction: input.instruction,
      metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
      created_by: input.created_by,
      published_at: input.metadata?.published ? new Date() : undefined,
    },
  });
  return version.id;
}

export async function publishAtomVersion(atomId: string, version: string, createdBy?: string): Promise<void> {
  await prismaKnowledge.promptAtomVersion.updateMany({
    where: { atomId, status: 'published' },
    data: { status: 'superseded' },
  });
  await prismaKnowledge.promptAtomVersion.update({
    where: { atomId_version: { atomId, version } },
    data: { status: 'published', published_at: new Date(), created_by: createdBy || null },
  });
  await prismaKnowledge.promptAtom.update({
    where: { id: atomId },
    data: { version, status: 'published', updatedAt: new Date() },
  });
}

export async function getPublishedAtom(id: string): Promise<any | null> {
  return prismaKnowledge.promptAtom.findUnique({
    where: { id, status: 'published' },
    include: { versions: { where: { status: 'published' }, take: 1, orderBy: { created_at: 'desc' } } },
  });
}

export async function getAllPublishedAtoms(category?: string): Promise<any[]> {
  const where: any = { status: 'published' };
  if (category) where.category = category;
  return prismaKnowledge.promptAtom.findMany({ where, orderBy: { priority: 'desc' }, include: { versions: { where: { status: 'published' }, take: 1 } } });
}

export async function getAtomVersions(atomId: string): Promise<any[]> {
  return prismaKnowledge.promptAtomVersion.findMany({ where: { atomId }, orderBy: { created_at: 'desc' } });
}

export async function setAtomStatus(atomId: string, status: AtomStatus): Promise<void> {
  await prismaKnowledge.promptAtom.update({ where: { id: atomId }, data: { status } });
}

export async function getActiveVersions(): Promise<Record<string, { version: string; instruction: string }>> {
  const atoms = await prismaKnowledge.promptAtom.findMany({
    where: { status: 'published' },
    include: { versions: { where: { status: 'published' }, take: 1, orderBy: { created_at: 'desc' } } },
  });
  const out: Record<string, { version: string; instruction: string }> = {};
  for (const a of atoms) {
    const v = a.versions[0];
    if (v) out[a.id] = { version: v.version, instruction: v.instruction };
  }
  return out;
}

export async function compareVersions(atomId: string, v1: string, v2: string): Promise<{ v1: any; v2: any }> {
  const [a, b] = await Promise.all([
    prismaKnowledge.promptAtomVersion.findUnique({ where: { atomId_version: { atomId, version: v1 } } }),
    prismaKnowledge.promptAtomVersion.findUnique({ where: { atomId_version: { atomId, version: v2 } } }),
  ]);
  return { v1: a, v2: b };
}
