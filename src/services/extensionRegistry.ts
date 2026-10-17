// ================================================================
// Extension Registry — unified lifecycle for all extension types
// ================================================================
// Extension types: task, intent, response_mode, scenario, atom,
// knowledge_rule, verification_rule, output_mode, generation_profile,
// classification_rule, constraint_type, domain_module
//
// Lifecycle: Draft → Validate → Test → Preview → Publish → Archive
// With rollback support (version history).
// ================================================================

import { prismaKnowledge } from './db';
import { invalidateCatalogCache } from './contextAnalyzer';

export type ExtensionType =
  | 'task' | 'intent' | 'response_mode' | 'scenario'
  | 'atom' | 'knowledge_rule' | 'verification_rule'
  | 'output_mode' | 'generation_profile'
  | 'classification_rule' | 'constraint_type' | 'domain_module';

export type ExtensionStatus = 'draft' | 'validated' | 'tested' | 'preview' | 'published' | 'archived' | 'disabled';

export interface ExtensionInput {
  id: string;
  type: ExtensionType;
  name: string;
  description?: string;
  content: string;
  priority?: number;
  requires?: string[];
  conflicts_with?: string[];
  compatible_with?: string[];
  conditions?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ==================== CRUD ====================

export async function createExtension(input: ExtensionInput): Promise<string> {
  const { requires = [], conflicts_with = [], compatible_with = [] } = input;
  const atom = await prismaKnowledge.promptAtom.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      category: input.type,
      purpose: input.description || input.name,
      priority: input.priority ?? 50,
      requires: JSON.stringify(requires),
      conflicts_with: JSON.stringify(conflicts_with),
      compatible_with: JSON.stringify(compatible_with),
      conditions: JSON.stringify({ ...input.conditions, ...input.metadata, type: input.type, name: input.name }),
      status: 'draft',
      version: '1.0.0',
      tags: JSON.stringify([input.type]),
    },
    update: {},
  });

  const version = await prismaKnowledge.promptAtomVersion.create({
    data: {
      atomId: input.id,
      version: '1.0.0',
      instruction: input.content,
      metadata: JSON.stringify({ type: input.type, name: input.name, description: input.description }),
      status: 'draft',
    },
  });

  await prismaKnowledge.promptAtom.update({
    where: { id: input.id },
    data: { status: 'draft' },
  });

  return version.id;
}

export async function updateExtension(id: string, input: Partial<ExtensionInput>): Promise<void> {
  const atom = await prismaKnowledge.promptAtom.findUnique({ where: { id } });
  if (!atom) throw new Error(`Extension ${id} not found`);

  if (input.requires || input.conflicts_with || input.compatible_with || input.conditions || input.priority !== undefined) {
    await prismaKnowledge.promptAtom.update({
      where: { id },
      data: {
        requires: input.requires ? JSON.stringify(input.requires) : undefined,
        conflicts_with: input.conflicts_with ? JSON.stringify(input.conflicts_with) : undefined,
        compatible_with: input.compatible_with ? JSON.stringify(input.compatible_with) : undefined,
        conditions: input.conditions ? JSON.stringify(input.conditions) : undefined,
        priority: input.priority,
      },
    });
  }

  if (input.content) {
    const latestVersion = await prismaKnowledge.promptAtomVersion.findFirst({
      where: { atomId: id },
      orderBy: { created_at: 'desc' },
    });
    const newVersion = incrementVersion(latestVersion?.version || '1.0.0');
    await prismaKnowledge.promptAtomVersion.create({
      data: {
        atomId: id,
        version: newVersion,
        instruction: input.content,
        status: 'draft',
        metadata: JSON.stringify({ type: input.type || (JSON.parse(atom.tags || '[]')[0] as string), name: input.name }),
      },
    });
    await prismaKnowledge.promptAtom.update({
      where: { id },
      data: { version: newVersion, status: 'draft' },
    });
  }
}

export async function deleteExtension(id: string): Promise<void> {
  await prismaKnowledge.promptAtom.update({
    where: { id },
    data: { status: 'archived' },
  });
}

// ==================== Validate ====================

export async function validateExtension(id: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const atom = await prismaKnowledge.promptAtom.findUnique({
    where: { id },
    include: { versions: { orderBy: { created_at: 'desc' }, take: 1 } },
  });
  if (!atom) return { valid: false, errors: ['Extension not found'], warnings: [] };

  const version = atom.versions[0];
  if (!version) errors.push('No version found');

  // Schema validation
  if (!atom.id || atom.id.length < 3) errors.push('ID too short (min 3 chars)');
  if (!atom.category) errors.push('Missing category/type');

  // Dependency check
  for (const dep of JSON.parse(atom.requires || '[]')) {
    const depAtom = await prismaKnowledge.promptAtom.findUnique({ where: { id: dep } });
    if (!depAtom) warnings.push(`Required dependency "${dep}" not found`);
    else if (depAtom.status === 'archived') errors.push(`Required dependency "${dep}" is archived`);
  }

  // Conflict check
  for (const conflict of JSON.parse(atom.conflicts_with || '[]')) {
    const conflictAtom = await prismaKnowledge.promptAtom.findUnique({ where: { id: conflict } });
    if (conflictAtom && conflictAtom.status === 'published') {
      warnings.push(`Conflicts with published extension "${conflict}"`);
    }
  }

  // Prompt content check
  if (version) {
    if (version.instruction.length < 10) warnings.push('Instruction content is very short (< 10 chars)');
    if (version.instruction.length > 5000) warnings.push('Instruction content exceeds 5000 chars');
  }

  // Security check
  const content = version?.instruction || '';
  if (content.includes('ignore previous instructions') || content.includes('disregard all')) {
    errors.push('Potential prompt injection detected in content');
  }

  const valid = errors.length === 0;
  if (valid) {
    await prismaKnowledge.promptAtom.update({ where: { id }, data: { status: 'validated' } });
  }

  return { valid, errors, warnings };
}

// ==================== Test ====================

export async function testExtension(id: string, testInput?: Record<string, any>): Promise<{ passed: boolean; result?: string; error?: string }> {
  try {
    const atom = await prismaKnowledge.promptAtom.findUnique({
      where: { id },
      include: { versions: { where: { status: { in: ['published', 'validated', 'draft'] } }, orderBy: { created_at: 'desc' }, take: 1 } },
    });
    if (!atom) return { passed: false, error: 'Extension not found' };
    const version = atom.versions[0];
    if (!version) return { passed: false, error: 'No version found' };

    // Basic test: compose with this atom
    const { composePrompt } = await import('./promptComposer');
    const composition = await composePrompt([id], { test: testInput });
    if (!composition.final_prompt || composition.final_prompt.length < 10) {
      return { passed: false, error: 'Composed prompt is empty or too short' };
    }
    return { passed: true, result: composition.final_prompt.substring(0, 500) };
  } catch (err: any) {
    return { passed: false, error: err.message };
  }
}

// ==================== Preview ====================

export async function previewExtension(id: string): Promise<{ atom: any; version: any; composition?: string }> {
  const atom = await prismaKnowledge.promptAtom.findUnique({
    where: { id },
    include: { versions: { where: { status: 'published' }, orderBy: { created_at: 'desc' }, take: 1 } },
  });
  if (!atom) throw new Error(`Extension ${id} not found`);
  const version = atom.versions[0];
  return { atom, version };
}

// ==================== Publish ====================

export async function publishExtension(id: string, version?: string, createdBy?: string): Promise<string> {
  const atom = await prismaKnowledge.promptAtom.findUnique({ where: { id } });
  if (!atom) throw new Error(`Extension ${id} not found`);

  const targetVersion = version || atom.version;
  const versionRecord = await prismaKnowledge.promptAtomVersion.findUnique({
    where: { atomId_version: { atomId: id, version: targetVersion } },
  });
  if (!versionRecord) throw new Error(`Version ${targetVersion} not found`);

  // Pre-publish validation
  const validation = await validateExtension(id);
  if (!validation.valid) {
    throw new Error(`Cannot publish: ${validation.errors.join('; ')}`);
  }

  // Supersede old published versions
  await prismaKnowledge.promptAtomVersion.updateMany({
    where: { atomId: id, status: 'published' },
    data: { status: 'archived' },
  });

  await prismaKnowledge.promptAtomVersion.update({
    where: { id: versionRecord.id },
    data: { status: 'published', published_at: new Date(), created_by: createdBy || null },
  });

  await prismaKnowledge.promptAtom.update({
    where: { id },
    data: { status: 'published', version: targetVersion },
  });

  invalidateCatalogCache();
  return targetVersion;
}

export async function unpublishExtension(id: string): Promise<void> {
  await prismaKnowledge.promptAtom.update({
    where: { id },
    data: { status: 'validated' },
  });
  await prismaKnowledge.promptAtomVersion.updateMany({
    where: { atomId: id, status: 'published' },
    data: { status: 'validated' },
  });
  invalidateCatalogCache();
}

export async function rollbackExtension(id: string, targetVersion: string): Promise<void> {
  const versionRecord = await prismaKnowledge.promptAtomVersion.findUnique({
    where: { atomId_version: { atomId: id, version: targetVersion } },
  });
  if (!versionRecord) throw new Error(`Version ${targetVersion} not found`);
  await prismaKnowledge.promptAtomVersion.update({
    where: { id: versionRecord.id },
    data: { status: 'published', published_at: new Date() },
  });
  await prismaKnowledge.promptAtom.update({
    where: { id },
    data: { status: 'published', version: targetVersion },
  });
  invalidateCatalogCache();
}

// ==================== Versions ====================

export async function listVersions(id: string): Promise<any[]> {
  return prismaKnowledge.promptAtomVersion.findMany({
    where: { atomId: id },
    orderBy: { created_at: 'desc' },
  });
}

export async function compareVersions(id: string, v1: string, v2: string): Promise<{ v1: any; v2: any; diff: string }> {
  const [rec1, rec2] = await Promise.all([
    prismaKnowledge.promptAtomVersion.findUnique({ where: { atomId_version: { atomId: id, version: v1 } } }),
    prismaKnowledge.promptAtomVersion.findUnique({ where: { atomId_version: { atomId: id, version: v2 } } }),
  ]);
  const diff = simpleDiff(rec1?.instruction || '', rec2?.instruction || '');
  return { v1: rec1, v2: rec2, diff };
}

// ==================== Query ====================

export async function listExtensions(type?: string, status?: string, search?: string): Promise<any[]> {
  const where: any = {};
  if (status) where.status = status;
  if (type) where.tags = { has: type };
  if (search) where.OR = [
    { id: { contains: search, mode: 'insensitive' } },
    { purpose: { contains: search, mode: 'insensitive' } },
  ];
  return prismaKnowledge.promptAtom.findMany({
    where,
    include: { versions: { where: { status: 'published' }, take: 1, orderBy: { created_at: 'desc' } } },
    orderBy: { priority: 'desc' },
    take: 200,
  });
}

// ==================== Dependencies & Conflicts ====================

export async function getDependencies(id: string): Promise<{ requires: string[]; resolved: string[]; missing: string[] }> {
  const atom = await prismaKnowledge.promptAtom.findUnique({ where: { id } });
  if (!atom) return { requires: [], resolved: [], missing: [] };

  const requires = JSON.parse(atom.requires || '[]') as string[];
  const resolved: string[] = [];
  const missing: string[] = [];
  for (const dep of requires) {
    const depAtom = await prismaKnowledge.promptAtom.findUnique({ where: { id: dep } });
    if (depAtom && depAtom.status === 'published') resolved.push(dep);
    else missing.push(dep);
  }
  return { requires, resolved, missing };
}

export async function getConflicts(id: string): Promise<{ conflicts: string[]; active: string[] }> {
  const atom = await prismaKnowledge.promptAtom.findUnique({ where: { id } });
  if (!atom) return { conflicts: [], active: [] };

  const conflicts = JSON.parse(atom.conflicts_with || '[]') as string[];
  const active: string[] = [];
  for (const conflict of conflicts) {
    const conflictAtom = await prismaKnowledge.promptAtom.findUnique({ where: { id: conflict } });
    if (conflictAtom && conflictAtom.status === 'published') active.push(conflict);
  }
  return { conflicts, active };
}

// ==================== Helpers ====================

function incrementVersion(v: string): string {
  const parts = v.split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join('.');
}

function simpleDiff(a: string, b: string): string {
  if (a === b) return '(no changes)';
  const linesA = a.split('\n');
  const linesB = b.split('\n');
  const max = Math.max(linesA.length, linesB.length);
  const diff: string[] = [];
  for (let i = 0; i < max; i++) {
    if (linesA[i] !== linesB[i]) {
      diff.push(`- ${linesA[i] || ''}`);
      diff.push(`+ ${linesB[i] || ''}`);
    }
  }
  return diff.length > 0 ? diff.join('\n') : '(content differs)';
}
