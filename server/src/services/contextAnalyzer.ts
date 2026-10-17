// ================================================================
// Context Analyzer — multi-dimensional analysis (Agnes-backed).
// local-first classification; only generic messages escalate to
// Agnes 2.5-flash. Dynamically injects the Atom/Scenario catalog
// into the prompt.
// ================================================================

import { localClassify, type MultiDimClassification } from './taskTaxonomy';
import { prismaKnowledge } from './db';
import { callAgnes } from './scenarioWorkers/agnesCaller';

export interface GeminiAnalysisResult {
  classification: MultiDimClassification;
  generation_profile: {
    creativity: number;
    exploration: number;
    structure: number;
    consistency: number;
    diversity: number;
  };
  confidence: number;
  raw?: string;
}

const GEMINI_SYSTEM_PROMPT_BASE = `You are a task understanding engine for an AI assistant. Analyze the user's message and return a structured JSON classification.

RULES:
1. Output ONLY valid JSON — no markdown, no code fences, no explanation.
2. "tasks" is an array of task type strings (can be multiple).
3. "scenarios" lists valid scenario IDs from the AVAILABLE SCENARIOS list (max 4).
4. "atoms" lists relevant prompt atom IDs from the AVAILABLE ATOMS list (max 12). You MUST only select atoms that exist in the AVAILABLE ATOMS list.
5. "response_mode" is one of: single_answer, single_recommendation, multi_option, shortlist, compare, decision_support, exploration, brainstorm, information_only, step_by_step, deep_analysis.
6. "recommendation_mode" (if applicable): recommend_one, recommend_several, recommend_best_fit, recommend_budget, recommend_requirement, recommend_current, recommend_alternative, recommend_shortlist, recommend_with_reason, recommend_with_comparison.
7. "multi_option_mode" (if applicable): multi_option, multi_option_ranked, multi_option_unranked, multi_option_tradeoff, multi_option_budget, multi_option_complexity, multi_option_risk, multi_option_speed, multi_option_quality, multi_option_custom, multi_option_fallback, multi_option_a_b, multi_option_comprehensive.
8. "answer_cardinality": single, few, several, many, exhaustive, unknown.
9. "knowledge_mode": none, static, current, database, web, database_then_web, multi_source, primary_source, verification, estimate, conflict.
10. "accuracy": low, medium, high, critical.
11. "creativity": integer 0-5.
12. "ambiguity": none, low, medium, high.
13. "freshness": none, stable, recent, current, real_time.
14. "output_type": text, structured, list, table, comparison_table, steps, checklist, json, code, formula, timeline, matrix, report.
15. "depth": minimal, short, normal, detailed, deep, exhaustive.
16. "reasoning_style": direct, analytical, comparative, stepwise, evidence_based, constraint_based, diagnostic, exploratory, creative, structured.
17. "risk": none, low, medium, high, critical.
18. "knowledge_required": boolean.
19. "verification_required": boolean.
20. "generation_profile": { creativity: 0-5, exploration: 0-1, structure: 0-1, consistency: 0-1, diversity: 0-1 }.

IMPORTANT: Only select atoms and scenarios that exist in the provided lists. Do NOT invent new IDs. If no specific atom fits, use the general/core ones.`;

// ==================== Dynamic Catalog Cache ====================

let _catalogCache: string | null = null;
let _catalogTimestamp = 0;
const CATALOG_TTL_MS = 60_000;

export async function buildDynamicSystemPrompt(): Promise<string> {
  const now = Date.now();
  if (_catalogCache && now - _catalogTimestamp < CATALOG_TTL_MS) {
    return _catalogCache;
  }

  try {
    const [atoms, scenarios] = await Promise.all([
      prismaKnowledge.promptAtom.findMany({
        where: { status: 'published' },
        select: { id: true, category: true, purpose: true },
        take: 200,
        orderBy: { priority: 'desc' },
      }),
      prismaKnowledge.scenario.findMany({
        where: { status: 'published' },
        select: { id: true, name: true, category: true },
        take: 300,
        orderBy: { priority: 'desc' },
      }),
    ]);

    const atomLines = atoms.length > 0
      ? atoms.map(a => `- ${a.id} [${a.category}] ${a.purpose || ''}`).join('\n')
      : '(no atoms published yet)';
    const scenarioLines = scenarios.length > 0
      ? scenarios.map(s => `- ${s.id} [${s.category}] ${s.name}`).join('\n')
      : '(no scenarios published yet)';

    const dynamic = `\nAVAILABLE ATOMS (select from these only):\n${atomLines}\n\nAVAILABLE SCENARIOS (select from these only):\n${scenarioLines}`;

    _catalogCache = GEMINI_SYSTEM_PROMPT_BASE + dynamic;
    _catalogTimestamp = now;
  } catch {
    if (!_catalogCache) _catalogCache = GEMINI_SYSTEM_PROMPT_BASE;
  }

  return _catalogCache;
}

export function invalidateCatalogCache(): void {
  _catalogCache = null;
  _catalogTimestamp = 0;
}

// ==================== Context Builder ====================

export function buildRuntimeContext(
  message: string,
  conversationHistory: Array<{ role: string; content: string }>,
  opts?: { language?: string; region?: string; userTier?: string; files?: string[] },
): Record<string, any> {
  return {
    user_message: message,
    conversation_history: conversationHistory.slice(-10),
    language: opts?.language,
    region: opts?.region,
    user_tier: opts?.userTier,
    files: opts?.files,
  };
}

// ==================== Gemini Call ====================

export async function callGeminiAnalysis(context: Record<string, any>): Promise<GeminiAnalysisResult> {
  const local = localClassify(String(context.user_message || ''));

  // local-first: trust the local classifier when it produced a specific
  // classification (a concrete task was detected). Only escalate to Gemini for
  // generic messages the local rules leave at the default single 'answer' +
  // general.chat, where semantic judgment actually helps. This skips a model
  // call for the majority of concrete requests.
  if (localIsSpecific(local)) {
    return {
      classification: local,
      generation_profile: { creativity: local.creativity, exploration: 0.5, structure: 0.5, consistency: 0.5, diversity: 0.5 },
      confidence: 0.55,
    };
  }

  try {
    return await callGemini(context);
  } catch {
    return {
      classification: local,
      generation_profile: { creativity: local.creativity, exploration: 0.5, structure: 0.5, consistency: 0.5, diversity: 0.5 },
      confidence: 0.4,
    };
  }
}

// Generic = fell through to the single default task + general scenario with no
// detection branch firing. Specific otherwise (some task/atom was detected).
function localIsSpecific(c: MultiDimClassification): boolean {
  const defaulted =
    c.tasks.length === 1 &&
    c.tasks[0] === 'answer' &&
    c.atoms.length <= 2 &&
    c.scenarios.length === 1 &&
    c.scenarios[0] === 'general.chat';
  return !defaulted;
}

async function callGemini(context: Record<string, any>): Promise<GeminiAnalysisResult> {
  const systemPrompt = await buildDynamicSystemPrompt();

  // Agnes-backed (migrated off Gemini): escalation now only ever uses
  // Agnes 2.5-flash through the shared pool.
  const text = await callAgnes(systemPrompt, JSON.stringify(context), {
    model: 'agnes-2.5-flash',
    temperature: 0.1,
    maxTokens: 1024,
    timeoutMs: 60_000,
  });
  const clean = text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed: any;
  try {
    parsed = JSON.parse(clean || '{}');
  } catch {
    throw new Error('Agnes returned invalid JSON');
  }

  const classification = mergeClassification(parsed);
  const generation_profile = {
    creativity: typeof parsed?.generation_profile?.creativity === 'number' ? parsed.generation_profile.creativity : 2,
    exploration: typeof parsed?.generation_profile?.exploration === 'number' ? parsed.generation_profile.exploration : 0.5,
    structure: typeof parsed?.generation_profile?.structure === 'number' ? parsed.generation_profile.structure : 0.5,
    consistency: typeof parsed?.generation_profile?.consistency === 'number' ? parsed.generation_profile.consistency : 0.5,
    diversity: typeof parsed?.generation_profile?.diversity === 'number' ? parsed.generation_profile.diversity : 0.5,
  };

  return {
    classification,
    generation_profile,
    confidence: typeof parsed?.confidence === 'number' ? parsed.confidence : 0.7,
    raw: text,
  };
}

// ==================== Classification Merge ====================

function mergeClassification(raw: any): MultiDimClassification {
  const def: MultiDimClassification = {
    tasks: ['answer'],
    response_mode: 'information_only',
    answer_cardinality: 'single',
    knowledge_mode: 'static',
    accuracy: 'medium',
    creativity: 2,
    ambiguity: 'none',
    freshness: 'none',
    output_type: 'text',
    depth: 'normal',
    reasoning_style: 'direct',
    risk: 'none',
    scenarios: ['general.chat'],
    domains: [],
    atoms: ['core.identity'],
    knowledge_required: false,
    verification_required: false,
  };

  return {
    tasks: Array.isArray(raw.tasks) && raw.tasks.length > 0 ? raw.tasks : def.tasks,
    response_mode: raw.response_mode || def.response_mode,
    recommendation_mode: raw.recommendation_mode || undefined,
    multi_option_mode: raw.multi_option_mode || undefined,
    answer_cardinality: raw.answer_cardinality || def.answer_cardinality,
    knowledge_mode: raw.knowledge_mode || def.knowledge_mode,
    accuracy: raw.accuracy || def.accuracy,
    creativity: typeof raw.creativity === 'number' ? raw.creativity : def.creativity,
    ambiguity: raw.ambiguity || def.ambiguity,
    freshness: raw.freshness || def.freshness,
    output_type: raw.output_type || def.output_type,
    depth: raw.depth || def.depth,
    reasoning_style: raw.reasoning_style || def.reasoning_style,
    risk: raw.risk || def.risk,
    scenarios: Array.isArray(raw.scenarios) && raw.scenarios.length > 0 ? raw.scenarios.slice(0, 4) : def.scenarios,
    domains: Array.isArray(raw.domains) ? raw.domains : def.domains,
    atoms: Array.isArray(raw.atoms) && raw.atoms.length > 0 ? raw.atoms.slice(0, 12) : def.atoms,
    knowledge_required: raw.knowledge_required ?? def.knowledge_required,
    verification_required: raw.verification_required ?? def.verification_required,
    option_count_hint: raw.option_count_hint ?? undefined,
  };
}
