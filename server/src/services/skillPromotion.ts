// ================================================================
// Skill Promotion — admin curates an account-scoped install into the
// global formal-Skill pool.
//
// This is the ONLY path where a user-installed skill becomes visible
// to everyone. It deliberately reuses the global upsert + S1 enqueue
// flow (importService / SkillPublishGuard) so the frozen invariant
// holds: a formal Skill is written by admin import, never by AI.
//
// Global pool = prismaKnowledge.skill (versioned, S1-analyzed).
// The source row (UserInstalledSkill) is marked promoted + linked.
// ================================================================

import { prismaUser, prismaKnowledge } from './db';
import { guardSkillPublication, enqueueSkillAnalysis } from './skillPublishGuard';

export interface PromoteResult {
  ok: boolean;
  installedSkillId: string;
  globalSkillId?: string;
  created?: boolean;
  analysisEnqueued?: boolean;
  error?: string;
}

/**
 * Promote one account install into the global Skill pool. Idempotent by
 * skill name (the global table has no name uniqueness, so we upsert on
 * name and bump the version). The install row is flipped to `promoted`
 * and linked to the global Skill id.
 */
export async function promoteToGlobal(installedSkillId: string, adminId?: string): Promise<PromoteResult> {
  const src = await prismaUser.userInstalledSkill.findUnique({ where: { id: installedSkillId } });
  if (!src) return { ok: false, installedSkillId, error: 'Install not found' };

  // Guard is the single choke point for formal-Skill writes. admin_import
  // is the legal path for an admin-curation promotion.
  const guard = guardSkillPublication({ origin: 'admin_import', actorId: adminId });
  if (!guard.allowed) {
    return { ok: false, installedSkillId, error: guard.reason };
  }

  let globalSkill: { id: string; name: string };
  let created = false;
  const existing = await prismaKnowledge.skill.findFirst({ where: { name: src.name } });
  if (existing) {
    await prismaKnowledge.skill.update({
      where: { id: existing.id },
      data: {
        description: src.description ?? existing.description,
        prompt: src.prompt,
        category: src.category ?? existing.category,
        isActive: true,
      },
    });
    globalSkill = { id: existing.id, name: existing.name };
  } else {
    const g = await prismaKnowledge.skill.create({
      data: {
        name: src.name,
        description: src.description ?? null,
        prompt: src.prompt,
        category: src.category ?? null,
      },
    });
    globalSkill = { id: g.id, name: g.name };
    created = true;
  }

  // Enqueue S1 semantic analysis (version bump happens inside). Best-effort:
  // an analysis failure must not undo the promotion.
  let analysisEnqueued = false;
  try {
    await enqueueSkillAnalysis(globalSkill.id, created ? 'uploaded' : 'updated', adminId);
    analysisEnqueued = true;
  } catch {
    analysisEnqueued = false;
  }

  await prismaUser.userInstalledSkill.update({
    where: { id: src.id },
    data: { status: 'promoted', promotedSkillId: globalSkill.id },
  });

  return { ok: true, installedSkillId: src.id, globalSkillId: globalSkill.id, created, analysisEnqueued };
}

/**
 * Reject an account install (admin decides it should not be promoted /
 * kept active). Flips the row to `rejected` so it stops being injected
 * into the owner's context and is excluded from further promotion.
 */
export async function rejectInstall(installedSkillId: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  const res = await prismaUser.userInstalledSkill.updateMany({
    where: { id: installedSkillId },
    data: { status: 'rejected' },
  });
  if (res.count === 0) return { ok: false, error: 'Install not found' };
  if (reason) {
    await prismaUser.userInstalledSkill.update({
      where: { id: installedSkillId },
      data: { scanReport: reason },
    });
  }
  return { ok: true };
}

/**
 * Deactivate a previously-promoted global Skill (roll a promotion back).
 * The global row is soft-deactivated; the install row is returned to active.
 */
export async function deactivatePromoted(promotedSkillId: string): Promise<{ ok: boolean; error?: string }> {
  await prismaKnowledge.skill.update({ where: { id: promotedSkillId }, data: { isActive: false } });
  const links = await prismaUser.userInstalledSkill.findMany({ where: { promotedSkillId } });
  for (const l of links) {
    await prismaUser.userInstalledSkill.update({ where: { id: l.id }, data: { status: 'active', promotedSkillId: null } });
  }
  return { ok: true };
}
