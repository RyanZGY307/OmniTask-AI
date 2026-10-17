// ================================================================
// Scenario Retrieval Layer — three pure rule functions (zero model).
// SQL + prefix matching, no vector index (R13.3). Candidate caps:
// scenarios ≤10, prompts ≤20, skills ≤15.
// ================================================================

import { prismaKnowledge } from '../db';
import type { ScenarioUnderstanding } from './p1ScenarioAnalyzer';
import type { P2Result, CandidateScenario } from './p2ScenarioResolver';
import type { CandidateAtom } from './p3PromptSelector';
import type { S2CandidateSkill } from './s2SkillJudge';

export interface RetrievalInput {
  p1: ScenarioUnderstanding;
  p2: P2Result;
}

// R3: scenario candidates from signature + intent + domain + object + features
// + parent path + tags. All rule-layer, no model cost.
export async function retrieveCandidateScenarios(input: RetrievalInput, limit = 10): Promise<CandidateScenario[]> {
  const { p1, p2 } = input;
  const scId = p2.matched_scenario_id ?? p2.new_scenario?.path;
  const sig = p1.scenario_signature || '';
  const domain = p1.domain || '';

  const seeds: Array<{ scenario: any; hit_reasons: string[] }> = [];
  if (scId) {
    const matched = await prismaKnowledge.scenario.findUnique({ where: { id: String(scId) } });
    if (matched) seeds.push({ scenario: matched, hit_reasons: ['path_prefix'] });
  }

  const keywordScenarios = await prismaKnowledge.scenario.findMany({
    where: {
      status: { in: ['published', 'experimental'] },
      OR: [
        { name: { contains: domain || ' ' } },
        { tags: { contains: p1.intent ? p1.intent : ' ' } },
        { path: { startsWith: sig ? sig.split(':')[0] : ' ' } },
      ],
    },
    orderBy: [{ priority: 'asc' }, { experiment_count: 'desc' }],
    take: limit,
  });
  for (const s of keywordScenarios) {
    if (!seeds.find((c) => c.scenario.id === s.id)) {
      seeds.push({ scenario: s, hit_reasons: ['keyword_hit'] });
    }
  }

  if (sig) {
    const prefix = sig.split(':')[0];
    const similar = await prismaKnowledge.scenario.findMany({
      where: { status: { in: ['published', 'experimental'] }, OR: [{ path: { contains: prefix } }, { tags: { contains: prefix } }] },
      take: limit,
    });
    for (const s of similar) {
      if (!seeds.find((c) => c.scenario.id === s.id)) {
        seeds.push({ scenario: s, hit_reasons: ['signature_hit'] });
      }
    }
  }

  seeds.sort((a, b) => {
    const aExp = (a.scenario as any).status === 'experimental' ? 1 : 0;
    const bExp = (b.scenario as any).status === 'experimental' ? 1 : 0;
    return aExp - bExp;
  });
  return seeds.slice(0, limit) as CandidateScenario[];
}

// R3: prompt candidates — published atoms under the scenario + inherited
// (parent-path) atoms, each with its ScenarioPromptCompat snapshot.
export async function retrieveCandidateAtoms(input: RetrievalInput, limit = 20): Promise<CandidateAtom[]> {
  const scId = input.p2.matched_scenario_id;
  const requiredAtoms = input.p1.contextual_features; // tag hints
  const result: CandidateAtom[] = [];

  const atoms = await prismaKnowledge.promptAtom.findMany({
    where: { status: 'published' },
    take: limit * 2,
  });

  for (const atom of atoms) {
    const compat = scId
      ? await prismaKnowledge.scenarioPromptCompat.findUnique({ where: { scenario_id_atom_id: { scenario_id: scId, atom_id: atom.id } } }).catch(() => null)
      : null;
    result.push({
      atom: { id: atom.id, version: atom.version, category: atom.category },
      compat: compat
        ? {
            experiment_count: compat.experiment_count,
            unique_user_count: compat.unique_user_count,
            correction_count: compat.correction_count,
            success_rate: compat.success_rate,
            lifecycle: compat.lifecycle,
          }
        : null,
    });
  }
  void requiredAtoms;
  return result.slice(0, limit);
}

// R3: skill candidates — SkillScenarioLink + S1 metadata + compat history.
export async function retrieveCandidateSkills(input: RetrievalInput, limit = 15): Promise<S2CandidateSkill[]> {
  const scId = input.p2.matched_scenario_id;
  const result: S2CandidateSkill[] = [];

  const skills = await prismaKnowledge.skill.findMany({ where: { isActive: true }, take: limit * 2 });

  for (const skill of skills) {
    let link = null;
    let compat = null;
    if (scId) {
      link = await prismaKnowledge.skillScenarioLink.findUnique({ where: { skill_id_scenario_id: { skill_id: skill.id, scenario_id: scId } } }).catch(() => null);
      compat = await prismaKnowledge.scenarioSkillCompat.findFirst({ where: { scenario_id: scId, skill_id: skill.id } }).catch(() => null);
    }
    result.push({
      skill: {
        id: skill.id,
        name: skill.name,
        description: skill.description ?? undefined,
        capabilities: JSON.parse(skill.capabilities || '[]'),
        constraints: JSON.parse(skill.constraints || '[]'),
      },
      link: link ? { confidence: link.confidence, autoDerived: link.autoDerived, rationale: link.rationale ?? undefined } : undefined,
      compat: compat
        ? {
            experiment_count: compat.experiment_count,
            unique_user_count: compat.unique_user_count,
            success_rate: compat.success_rate,
            recent_performance: compat.recent_performance,
            lifecycle: compat.lifecycle,
            inherited: compat.inherited,
          }
        : null,
    });
  }
  return result.slice(0, limit);
}

// Convenience: run all three in parallel.
export async function retrieveAll(input: RetrievalInput): Promise<{
  scenarios: CandidateScenario[];
  atoms: CandidateAtom[];
  skills: S2CandidateSkill[];
}> {
  const [scenarios, atoms, skills] = await Promise.all([
    retrieveCandidateScenarios(input),
    retrieveCandidateAtoms(input),
    retrieveCandidateSkills(input),
  ]);
  return { scenarios, atoms, skills };
}
