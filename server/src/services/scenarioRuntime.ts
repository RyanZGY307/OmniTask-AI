// ================================================================
// Scenario Runtime — new-chain orchestrator (P1-P5 + S1-S4 + E1).
// Feature-gated by CORTX_SCENARIO_RUNTIME (default off). When on, the
// new chain is the authoritative source of atom + skill selection and
// the final System Prompt comes only from the rule Composer. When the
// chain degrades fully, callers fall back to the legacy path.
//
// This module is wired into promptRuntime.ts — it does NOT replace the
// legacy chain, it runs alongside it under the flag.
// ================================================================

import { randomUUID } from 'crypto';
import { prismaKnowledge } from './db';
import { runP1, type ScenarioUnderstanding } from './scenarioWorkers/p1ScenarioAnalyzer';
import { runP2, type P2Result } from './scenarioWorkers/p2ScenarioResolver';
import { runP3, p3HardGate, p3ExploitExplore, type CandidateAtom } from './scenarioWorkers/p3PromptSelector';
import { runP4 } from './scenarioWorkers/p4PromptGenerator';
import { runS2, type S2CandidateSkill } from './scenarioWorkers/s2SkillJudge';
import { runS4, type S4Output } from './scenarioWorkers/s4SkillSelection';
import {
  retrieveAll,
  retrieveCandidateScenarios,
  retrieveCandidateAtoms,
  retrieveCandidateSkills,
} from './scenarioWorkers/scenarioRetrieval';

export interface ScenarioRuntimeInput {
  userMessage: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  region?: string;
  language?: string;
  userId?: string;
  userTier?: string;
  cachedIntent?: Record<string, any>;
  knownScenarioSignatures?: string[]; // lightweight retrieval hint (R1.2)
}

export interface ScenarioRuntimeResult {
  ok: boolean;
  degraded: boolean;
  traceId: string;
  p1?: ScenarioUnderstanding;
  p2?: P2Result;
  selectedAtomIds?: string[];
  experimentalAtomIds?: string[];
  selectedSkillIds?: string[];
  s4?: S4Output;
  noSuitablePrompt?: boolean;
  p4Attempted?: boolean;
  fallbackReason?: string;
}

export async function runScenarioRuntime(input: ScenarioRuntimeInput): Promise<ScenarioRuntimeResult> {
  const traceId = randomUUID();
  const base: ScenarioRuntimeResult = { ok: false, degraded: false, traceId };

  try {
    // Step 1: P1 (W0 runs in parallel by the caller; P1 only takes cached_intent)
    const p1 = await runP1({
      user_message: input.userMessage,
      conversation_history: input.conversationHistory,
      region: input.region,
      language: input.language,
      cached_intent: input.cachedIntent,
      known_scenario_signatures: input.knownScenarioSignatures,
    });

    // Step 2: P2 resolution over retrieval candidates
    const stubP2: P2Result = {
      resolution: 'reuse_exact',
      matched_scenario_id: null,
      new_scenario: null,
      inherited_from: null,
      reason: '',
    };
    const retrievalInput = { p1, p2: stubP2 };
    const scenarios = await retrieveCandidateScenarios(retrievalInput).catch(() => []);
    const p2 = await runP2(p1, scenarios);

    // Rule-layer executes P2's proposal (create/merge/split) — see below.
    const scenarioId = await executeP2Resolution(p2);

    // Step 3: parallel retrieval (prompts + skills).
    // These two calls used to each invoke retrieveAll(), which re-ran the
    // scenario query as well — 2 wasted scenario queries per request.
    const retrievalInput2: any = { p1, p2 };
    const [atomCandidates, skillCandidates] = await Promise.all([
      retrieveCandidateAtoms(retrievalInput2).catch(() => [] as CandidateAtom[]),
      retrieveCandidateSkills(retrievalInput2).catch(() => [] as S2CandidateSkill[]),
    ]);
    const atoms = atomCandidates;
    const skills = skillCandidates;

    // Step 4: P3 (prompts) + S2 (skills) in parallel
    const [p3, s2] = await Promise.all([
      runP3({ id: scenarioId ?? '', name: p1.domain, category: p1.domain }, atoms),
      runS2({ id: scenarioId ?? '', name: p1.domain, category: p1.domain, signature: p1.scenario_signature }, skills),
    ]);

    // Step 5: P4 only when new scenario + no suitable prompt
    let p4Attempted = false;
    let finalAtoms = p3;
    if (p3.no_suitable_prompt && (p2.resolution === 'create_new' || p2.resolution === 'create_child') && scenarioId) {
      p4Attempted = true;
      const p4 = await runP4({
        scenario_id: scenarioId,
        scenario_tags: p1.contextual_features,
        user_message: input.userMessage,
        p1,
      });
      if (p4) {
        await persistP4Draft(p4, scenarioId);
        // P4 produced a new experimental atom -> feed it back to P3 selection
        const withNew = [...atoms, { atom: { id: 'p4-generated', version: 'experimental', category: 'task' }, compat: null }];
        finalAtoms = await runP3({ id: scenarioId ?? '', name: p1.domain, category: p1.domain }, withNew);
      }
    }

    // Step 6: rule-layer two-stage P3 selection
    const gated = p3HardGate(finalAtoms.candidates, atoms);
    const { exploit } = p3ExploitExplore(gated, atoms);
    const selectedAtomIds = [...new Set([...exploit.map((c) => c.atom_id), ...finalAtoms.experimental_atom_ids])];

    // Step 7: S4 final skill selection
    const s4 = await runS4({ s2, scenario: { id: scenarioId ?? '', name: p1.domain, category: p1.domain }, user_tier: input.userTier });

    // Persist SelectionDecision
    await persistSelectionDecision({
      traceId,
      userId: input.userId,
      scenarioId,
      selectedAtomIds,
      selectedSkillIds: s4.selected_skill_ids,
      source: p1.degraded || p2.degraded ? 'rule_fallback' : 'ai',
      fallbackReason: p1.degraded ? 'p1_failed' : p2.degraded ? 'p2_failed' : undefined,
    });

    return {
      ok: true,
      degraded: !!(p1.degraded || p2.degraded),
      traceId,
      p1,
      p2,
      selectedAtomIds,
      experimentalAtomIds: finalAtoms.experimental_atom_ids,
      selectedSkillIds: s4.selected_skill_ids,
      s4,
      noSuitablePrompt: p3.no_suitable_prompt,
      p4Attempted,
    };
  } catch (err: any) {
    // Full-chain failure -> legacy compiler path (R14.2)
    console.warn(`[ScenarioRuntime] chain failed, will fall back to legacy: ${err?.message}`);
    return { ...base, ok: false, degraded: true, fallbackReason: 'chain_failed' };
  }
}

// P2 execution (rule layer): create experimental scenario or link inheritance.
async function executeP2Resolution(p2: P2Result): Promise<string | null> {
  switch (p2.resolution) {
    case 'reuse_exact':
    case 'inherit_existing':
      return p2.matched_scenario_id;
    case 'create_new':
    case 'create_child': {
      if (!p2.new_scenario?.name) return p2.matched_scenario_id;
      const scenario = await prismaKnowledge.scenario.create({
        data: {
          id: randomUUID(),
          name: p2.new_scenario.name,
          category: p2.new_scenario.category || 'general',
          description: p2.new_scenario.description || null,
          path: p2.new_scenario.path ?? p2.new_scenario.name.toLowerCase().replace(/\s+/g, '/'),
          parent_id: p2.new_scenario.parent_id ?? p2.matched_scenario_id,
          status: 'experimental',
          origin: 'ai_suggested',
          first_seen_at: new Date(),
        },
      });
      if (p2.inherited_from || p2.matched_scenario_id) {
        await prismaKnowledge.scenarioRelation.create({
          data: {
            source_id: scenario.id,
            target_id: p2.inherited_from ?? p2.matched_scenario_id!,
            relation_type: p2.resolution === 'create_child' ? 'inherited_from' : 'related_to',
            confidence: 0.6,
          },
        }).catch(() => undefined);
      }
      return scenario.id;
    }
    case 'merge_candidate':
    case 'split_candidate':
      // Rule layer writes an EvolutionCandidate only (no direct DB mutation).
      await prismaKnowledge.evolutionCandidate.create({
        data: {
          id: randomUUID(),
          scope: 'scenario',
          changeType: p2.resolution,
          targetType: 'scenario',
          targetId: p2.matched_scenario_id ?? undefined,
          targetScenarioId: p2.matched_scenario_id ?? undefined,
          hypothesis: p2.reason,
          content: JSON.stringify({ p2 }),
          status: 'pending',
          gateLevel: 2,
          canaryPercent: 0,
          createdBy: 'scenario-runtime',
        },
      }).catch(() => undefined);
      return p2.matched_scenario_id;
    default:
      return p2.matched_scenario_id;
  }
}

// P4 persists a draft experimental version + compat placeholder row (R6.5).
async function persistP4Draft(p4: Awaited<ReturnType<typeof runP4>>, scenarioId: string): Promise<void> {
  if (!p4) return;
  await prismaKnowledge.promptAtom.create({
    data: {
      id: randomUUID(),
      category: 'task',
      purpose: p4.purpose,
      status: 'draft',
      version: '0.1.0-experimental',
      tags: (p4.scenario_tags ?? []).join(','),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  }).catch(() => undefined);
  await prismaKnowledge.scenarioPromptCompat.create({
    data: {
      scenario_id: scenarioId,
      atom_id: 'p4-generated',
      experiment_count: 0,
      unique_user_count: 0,
      success_rate: 0.5,
      lifecycle: 'experimental',
      created_at: new Date(),
      updated_at: new Date(),
    },
  }).catch(() => undefined);
}

async function persistSelectionDecision(args: {
  traceId: string;
  userId?: string;
  scenarioId: string | null;
  selectedAtomIds: string[];
  selectedSkillIds: string[];
  source: string;
  fallbackReason?: string;
}): Promise<void> {
  await prismaKnowledge.selectionDecision.create({
    data: {
      trace_id: args.traceId,
      user_id: args.userId ?? null,
      scenario_id: args.scenarioId,
      selected_atom_ids: JSON.stringify(args.selectedAtomIds),
      selected_skill_ids: JSON.stringify(args.selectedSkillIds),
      source: args.source,
      fallback_reason: args.fallbackReason ?? null,
      outcome: 'pending',
      created_at: new Date(),
    },
  }).catch(() => undefined);
}
