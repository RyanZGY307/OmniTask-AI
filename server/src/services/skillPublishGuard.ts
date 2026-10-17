// ================================================================
// Skill Publish Guard + S1 Enqueue — rule-layer interceptor enforcing
// the frozen Skill principle: AI can understand/classify/judge Skills,
// but it NEVER publishes a formal Skill, uploads a Skill, modifies
// admin's original Skill, or degrades a Skill's global quality on the
// basis of one scenario's failure.
//
// Formal Skill publication happens ONLY through admin routes
// (POST/PUT /api/knowledge/skills, admin import) which already carry
// adminAuth. This guard is the single choke point every non-admin
// write path must pass, and it also enqueues S1 semantic analysis for
// admin-created/updated Skills.
// ================================================================

import { prismaUser } from './db';

export interface SkillPublishSource {
  origin: 'admin_route' | 'admin_import' | 'ai_generated' | 'auto_derived' | 'unknown';
  actorId?: string;
}

export interface PublishGuardResult {
  allowed: boolean;
  reason: string;
  bumpedVersion: boolean;
}

// Hard rule: only admin-origin writes can create or publish a formal Skill.
// AI-generated / auto-derived / unknown origins are rejected outright (R8).
export function guardSkillPublication(source: SkillPublishSource): PublishGuardResult {
  switch (source.origin) {
    case 'admin_route':
    case 'admin_import':
      return { allowed: true, reason: 'admin-origin write is the only legal formal-Skill path', bumpedVersion: true };
    case 'ai_generated':
      return { allowed: false, reason: 'AI cannot generate or publish a formal Skill', bumpedVersion: false };
    case 'auto_derived':
      return { allowed: false, reason: 'rule-layer auto-derivation never publishes a Skill, only enriches metadata', bumpedVersion: false };
    case 'unknown':
    default:
      return { allowed: false, reason: 'unidentified write source is denied by default', bumpedVersion: false };
  }
}

// A rejected publication attempt must never flip a Skill's global quality
// downward (R8.8): the Skill table has NO global quality column by design,
// so this function documents + enforces that invariant at the rule layer.
export function assertNoGlobalSkillQualityWrite(field: string): void {
  const forbidden = ['globalQuality', 'qualityScore', 'globalScore', 'overallScore'];
  if (forbidden.includes(field)) {
    throw new Error(`Invariant R8.8 violated: "${field}" is a forbidden global Skill quality column. Skill quality is per-(skill,scenario) only.`);
  }
}

// After an admin creates or updates a Skill (content change), enqueue S1
// semantic analysis. Content change => version+1 + re-analysis (R9.3).
export async function enqueueSkillAnalysis(skillId: string, trigger: 'uploaded' | 'updated', actorId?: string): Promise<string> {
  const job = await prismaUser.skillAnalysisJob.create({
    data: {
      skillId,
      trigger,
      status: 'QUEUED',
      attemptCount: 0,
      queuedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  // Bump the Skill version so the next S1 run re-analyzes changed content.
  // This is metadata-only; it never touches Skill.prompt or publishes.
  await bumpSkillVersion(skillId);
  void actorId;
  return job.id;
}

import { prismaKnowledge } from './db';

async function bumpSkillVersion(skillId: string): Promise<void> {
  await prismaKnowledge.skill.update({
    where: { id: skillId },
    data: { version: { increment: 1 }, analysisStatus: 'analyzing', lastAnalyzedAt: null },
  }).catch(() => undefined);
}
