// ================================================================
// S1 Skill Semantic Job — executes a queued SkillAnalysisJob. Reads the
// Skill content, runs S1 (Agnes-2.5-flash), and the RULE LAYER writes
// the nine semantic fields back to Skill metadata columns + creates
// SkillScenarioLink rows. S1 never writes Skill.prompt and never
// publishes a formal Skill (Skill root principle, R8/R9).
// ================================================================

import { prismaKnowledge, prismaUser } from './db';
import { runS1 } from './scenarioWorkers/s1SkillSemantic';

export interface S1JobResult {
  jobId: string;
  ok: boolean;
  skillId: string;
  error?: string;
}

export async function executeSkillAnalysisJob(jobId: string): Promise<S1JobResult> {
  const job = await prismaUser.skillAnalysisJob.findUnique({ where: { id: jobId } });
  if (!job) return { jobId, ok: false, skillId: '', error: 'job not found' };
  // Terminal guard: never re-run a completed/failed row.
  if (job.status === 'COMPLETED' || job.status === 'FAILED') {
    return { jobId, ok: false, skillId: job.skillId, error: `already ${job.status}` };
  }

  await prismaUser.skillAnalysisJob.update({
    where: { id: jobId },
    data: { status: 'RUNNING', workerId: `s1-${process.pid}` },
  }).catch(() => undefined);

  const skill = await prismaKnowledge.skill.findUnique({ where: { id: job.skillId } });
  if (!skill) {
    await markFailed(jobId, 'skill no longer exists');
    return { jobId, ok: false, skillId: job.skillId, error: 'skill no longer exists' };
  }

  const s1 = await runS1({ name: skill.name, description: skill.description ?? undefined, prompt: skill.prompt });

  if (!s1) {
    await markFailed(jobId, 'S1 produced no parseable output');
    await prismaKnowledge.skill.update({ where: { id: skill.id }, data: { analysisStatus: 'failed' } }).catch(() => undefined);
    return { jobId, ok: false, skillId: skill.id, error: 'S1 failed' };
  }

  // Rule layer writes S1 output into the nine metadata columns. AI content
  // is Schema-validated (arrays/strings only); it never reaches Skill.prompt.
  await prismaKnowledge.skill.update({
    where: { id: skill.id },
    data: {
      capabilities: JSON.stringify(s1.capabilities),
      constraints: JSON.stringify(s1.constraints),
      applicable_domains: JSON.stringify(s1.applicable_domains),
      applicable_task_types: JSON.stringify(s1.applicable_task_types),
      scenario_features: JSON.stringify(s1.scenario_features),
      negative_applicability: JSON.stringify(s1.negative_applicability),
      required_conditions: JSON.stringify(s1.required_conditions),
      optional_conditions: JSON.stringify(s1.optional_conditions),
      analysisStatus: 'analyzed',
      lastAnalyzedAt: new Date(),
    },
  });

  // S1 scenario tags become SkillScenarioLink initial candidates
  // (autoDerived=true, corrected later by real experiments — R8.9).
  if (s1.scenario_tags.length > 0) {
    await linkScenarios(skill.id, s1.scenario_tags).catch(() => undefined);
  }

  await prismaUser.skillAnalysisJob.update({
    where: { id: jobId },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      resultJson: JSON.stringify({ purpose: s1.purpose, scenario_tags: s1.scenario_tags, capabilities: s1.capabilities }),
    },
  });

  return { jobId, ok: true, skillId: skill.id };
}

async function linkScenarios(skillId: string, tags: string[]): Promise<void> {
  for (const tag of tags.slice(0, 8)) {
    // Find a scenario whose name/tags/category matches the tag; skip if none.
    const scenario = await prismaKnowledge.scenario.findFirst({
      where: {
        status: { in: ['published', 'experimental'] },
        OR: [{ name: { contains: tag } }, { tags: { contains: tag } }, { category: tag }],
      },
      take: 1,
    });
    if (!scenario) continue;
    await prismaKnowledge.skillScenarioLink
      .upsert({
        where: { skill_id_scenario_id: { skill_id: skillId, scenario_id: scenario.id } },
        update: { confidence: 0.6, autoDerived: true, rationale: `S1 tag: ${tag}` },
        create: { skill_id: skillId, scenario_id: scenario.id, confidence: 0.6, autoDerived: true, rationale: `S1 tag: ${tag}` },
      })
      .catch(() => undefined);
  }
}

async function markFailed(jobId: string, reason: string): Promise<void> {
  await prismaUser.skillAnalysisJob.update({
    where: { id: jobId },
    data: { status: 'FAILED', lastError: reason, completedAt: new Date() },
  }).catch(() => undefined);
}
