// ================================================================
// S2 Skill × Scenario Compatibility Judge — semantic fit of a Skill to
// the current scenario. "Semantic similarity" != "should use"; similar
// candidates cap at experimental. Historical compat data is a hint, not
// the sole basis. Decision enum: use | experimental | reject | none.
// ================================================================

import { callAgnes, parseWorkerJson } from './agnesCaller';
import { S2_SYSTEM } from './prompts';

export interface S2CandidateSkill {
  skill: { id: string; name: string; description?: string; capabilities?: string[]; constraints?: string[] };
  link?: { confidence: number; autoDerived: boolean; rationale?: string };
  compat?: {
    experiment_count: number;
    unique_user_count: number;
    success_rate: number;
    recent_performance?: number;
    lifecycle: string;
    inherited?: boolean;
  } | null;
}

export type S2Decision = 'use' | 'experimental' | 'reject' | 'none';

export interface S2Output {
  decisions: Array<{
    skill_id: string;
    decision: S2Decision;
    compatibility_score: number;
    reason_codes: string[];
    risk_notes: string;
  }>;
  overall_confidence: number;
}

const DECISIONS: S2Decision[] = ['use', 'experimental', 'reject', 'none'];

export async function runS2(
  scenario: { id: string; name: string; category: string; signature?: string },
  skills: S2CandidateSkill[],
): Promise<S2Output> {
  try {
    const raw = await callAgnes(
      S2_SYSTEM,
      JSON.stringify({ scenario, skills: skills.map((s) => ({ skill: s.skill, link: s.link, compat: s.compat })) }),
      { model: 'Agnes-2.5-flash', temperature: 0, maxTokens: 3072, timeoutMs: 15000 },
    );
    const parsed = parseWorkerJson<S2Output>(raw, { decision: DECISIONS } as any);
    if (!parsed?.decisions) throw new Error('S2 missing decisions');
    return {
      decisions: parsed.decisions
        .filter((d: any) => d && d.skill_id && DECISIONS.includes(d.decision))
        .map((d: any) => ({
          skill_id: String(d.skill_id),
          decision: d.decision as S2Decision,
          compatibility_score: typeof d.compatibility_score === 'number' ? d.compatibility_score : 0.5,
          reason_codes: Array.isArray(d.reason_codes) ? d.reason_codes.map(String) : [],
          risk_notes: String(d.risk_notes ?? ''),
        })),
      overall_confidence: typeof parsed.overall_confidence === 'number' ? parsed.overall_confidence : 0.5,
    };
  } catch (err: any) {
    // Degraded: no decisions -> caller falls back to discoverSkills rule path.
    console.warn(`[S2] degraded: ${err?.message}`);
    return { decisions: [], overall_confidence: 0 };
  }
}
