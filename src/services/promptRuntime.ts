// ================================================================
// Prompt Runtime — Full orchestration chain
// Context → Gemini → Classification → Atoms → Compose → Temperature
// → Model Request → Validation → Retry → Trace
// ================================================================

import { randomUUID } from 'crypto';
import { prismaKnowledge } from './db';
import { buildRuntimeContext, callGeminiAnalysis, type GeminiAnalysisResult } from './contextAnalyzer';
import { resolveDependencies, type DependencyResult } from './dependencyResolver';
import { resolveConflicts, type ConflictResult } from './conflictResolver';
import { composePrompt, type ComposeResult } from './promptComposer';
import { buildModelRequest, type ModelRequest } from './modelRequestBuilder';
import { computeTemperature, type GenerationProfile } from './generationProfile';
// 注意：temperature 引擎为纯模块，模型档位由 chat.ts 注入解析器；
// 本文件只消费 computeTemperature 的结果。
import { validateOutput, decideRetry, type OutputValidationResult } from './outputValidation';
import { queryKnowledge, buildKnowledgeSection, type KnowledgeResult } from './knowledgeRuntime';
import { webSearch, type SearchResult } from './searchLayer';
import { checkInjection, type InjectionCheckResult } from './promptInjectionGuard';
import { checkPoliticalContent, buildPoliticalSection, type PoliticalCheckResult } from './politicalSafety';
import { getModelCapability, clampTemperature } from './modelCapabilityRegistry';
import type { MultiDimClassification } from './taskTaxonomy';
import { routeKnowledgeScope, type KnowledgeScope } from './knowledgeScopeRouter';
import { buildKnowledgeRetrievalDirective, buildRetrievedKnowledgeBlock } from './knowledgeRetrievalDirective';
import { runScenarioRuntime, type ScenarioRuntimeResult } from './scenarioRuntime';

// Scenario-driven runtime feature flag (R14). Default off in the first
// release so the legacy chain stays authoritative until the new chain
// proves out. When on, the new chain is the authoritative source of
// atom + skill selection and the final prompt still comes from the rule
// Composer (no AI-authored system prompt).
export const SCENARIO_RUNTIME_ENABLED = process.env.CORTX_SCENARIO_RUNTIME === 'on';

export interface PromptRuntimeResult {
  composition: ComposeResult;
  dependencyResult: DependencyResult;
  conflictResult: ConflictResult;
  analysis: GeminiAnalysisResult;
  classification: MultiDimClassification;
  generationProfile: GenerationProfile;
  knowledgeResult: KnowledgeResult | null;
  knowledgeScope: KnowledgeScope | null;
  injectionCheck: InjectionCheckResult;
  politicalCheck: PoliticalCheckResult;
  runtimeContext: Record<string, any>;
  modelRequest: ModelRequest;
  temperature: number;
  targetModel: string;
  validation?: OutputValidationResult;
  retryCount: number;
  traceId: string;
  compositionHash: string;
  // Scenario-driven runtime (only populated when CORTX_SCENARIO_RUNTIME=on)
  scenarioRuntime?: ScenarioRuntimeResult;
}

export interface RuntimeOptions {
  language?: string;
  region?: string;
  userTier?: string;
  targetModel?: string;
  explicitTemperature?: number;
  userId?: string;
  requestId?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  enableKnowledge?: boolean;
  /** 事实信号时预检索并注入实时结果（默认开）；置 false 可禁用。 */
  enableWebSearch?: boolean;
  enableValidation?: boolean;
  enableRetry?: boolean;
}

export async function runPromptRuntime(
  userMessage: string,
  conversationHistory: Array<{ role: string; content: string }>,
  opts?: RuntimeOptions,
): Promise<PromptRuntimeResult> {
  const traceId = randomUUID();
  const startTime = Date.now();
  let retryCount = 0;

  try {
    // Step 1: Injection guard
    const injectionCheck = checkInjection(userMessage);
    if (injectionCheck.isInjection && injectionCheck.severity !== 'low') {
      console.warn(`[PromptRuntime] Injection detected (${injectionCheck.severity}): ${injectionCheck.indicators.join(', ')}`);
    }
    const safeMessage = injectionCheck.isInjection ? (injectionCheck.sanitized || userMessage) : userMessage;

    // Step 2: Political safety check
    const politicalCheck = checkPoliticalContent(safeMessage);

    // Step 3: Build runtime context
    const runtimeContext = buildRuntimeContext(safeMessage, conversationHistory, {
      language: opts?.language,
      region: opts?.region,
      userTier: opts?.userTier,
    });

    // Step 4: Gemini multi-dimensional analysis
    const analysis = await callGeminiAnalysis(runtimeContext);
    const classification = analysis.classification;

    // Step 4b (new): Scenario-Driven Runtime (feature-gated). When on, the
    // 10-Worker chain (P1/P2/P3/P4 + S2/S4) runs in parallel with the
    // legacy atom selection and becomes the authoritative source for
    // atom + skill selection. On full degradation the legacy path below
    // remains the fallback (R14). The final System Prompt still only
    // comes from the rule Composer — no AI-authored prompt.
    let scenarioRuntime: ScenarioRuntimeResult | undefined;
    if (SCENARIO_RUNTIME_ENABLED) {
      scenarioRuntime = await runScenarioRuntime({
        userMessage: safeMessage,
        conversationHistory,
        region: opts?.region,
        language: opts?.language,
        userId: opts?.userId,
        userTier: opts?.userTier,
        cachedIntent: { intent: classification.tasks[0], domain: classification.domains[0] },
        knownScenarioSignatures: classification.scenarios,
      });
      if (scenarioRuntime.ok) {
        // Authoritative atom selection from the new chain; the legacy
        // candidate set is replaced so the Composer uses the P3/S4 result.
        if (scenarioRuntime.selectedAtomIds?.length) {
          classification.atoms = scenarioRuntime.selectedAtomIds;
        }
        // S4 skill selection is recorded on the trace; the chat route
        // picks it up for the skill section of the composed prompt.
      }
    }

    // Step 5: Knowledge runtime (DB First → Web Fallback), scoped by the
    // Knowledge Scope Router. The router is a lightweight rule+metadata layer
    // (no LLM call) and must NEVER fail the request — on any error we fall
    // back to the existing unscoped Knowledge Runtime behavior.
    let knowledgeResult: KnowledgeResult | null = null;
    let knowledgeScope: KnowledgeScope | null = null;
    // 用户点名知识库/内部资料时也检索一次：分类器未必判定 knowledge_required
    const knowledgeAsked = /知识库|资料库|文档库|知识管理|内部文档|我们的资料|平台资料/i.test(safeMessage);
    if ((classification.knowledge_required || knowledgeAsked) && opts?.enableKnowledge !== false) {
      try {
        knowledgeScope = await routeKnowledgeScope({
          message: safeMessage,
          taskType: classification.tasks[0],
          domain: classification.domains[0],
          region: opts?.region,
          needsVerification: classification.verification_required,
        });
      } catch {
        // Scope Router is best-effort; an unscoped retrieval is the safe default.
        knowledgeScope = null;
      }
      knowledgeResult = await queryKnowledge({
        query: safeMessage,
        domain: classification.domains[0],
        maxChunks: 8,
        region: opts?.region,
        scope: knowledgeScope ?? undefined,
      }).catch(() => null); // Knowledge Runtime failure never fails the chat
    }

    // Step 6: Collect candidate atoms
    const candidateAtoms = new Set<string>(classification.atoms);
    for (const scenarioId of classification.scenarios) {
      const scenario = await import('./scenarioRegistry').then(m => m.getScenario(scenarioId)).catch(() => null);
      if (scenario) {
        for (const a of (scenario as any).required_atoms || []) candidateAtoms.add(a);
        for (const a of (scenario as any).optional_atoms || []) candidateAtoms.add(a);
      }
    }

    // Add political safety atoms if needed
    if (politicalCheck.neutralMode) {
      candidateAtoms.add('core.political_neutrality');
    }

    // Fallback: map task types to matching published atoms by category
    await resolveTaskAtomFallback(classification.tasks, candidateAtoms);

    // Step 7: Resolve dependencies
    const depResult = await resolveDependencies([...candidateAtoms]);

    // Step 8: Resolve conflicts
    const conflictResult = await resolveConflicts(depResult.resolved_atoms);

    // Step 9: Compute generation profile + dynamic temperature
    let generationProfile: GenerationProfile;
    let temperature: number;
    const targetModel = opts?.targetModel || 'Agnes-3.0-flash';

    if (opts?.explicitTemperature != null) {
      temperature = opts.explicitTemperature;
      generationProfile = {
        generation_mode: temperature <= 0.3 ? 'deterministic' : temperature >= 1.0 ? 'exploratory' : 'balanced',
        temperature,
        accuracy_target: 0.8,
        creativity_score: 2,
        exploration_score: 0.5,
        structure_score: 0.5,
        consistency_score: 0.5,
        diversity_score: 0.5,
        determinism_score: 0.5,
        risk_level: classification.risk,
        verification_level: classification.verification_required ? 'high' : 'medium',
        retry_strategy: 'none',
      };
    } else {
      const gp = analysis.generation_profile;
      generationProfile = computeTemperature({
        tasks: classification.tasks,
        creativity: classification.creativity,
        accuracy: classification.accuracy,
        exploration: gp.exploration,
        diversity: gp.diversity,
        structure: gp.structure,
        consistency: gp.consistency,
        risk: classification.risk,
        verification: classification.verification_required,
        targetModel,
      });
      temperature = generationProfile.temperature;
    }

    // Step 10: Compose final prompt with strict section isolation.
    // The Knowledge Retrieval Directive (guidance) and the Retrieved Knowledge
    // block (evidence) are kept as SEPARATE, fenced sections so the model can
    // distinguish "how to use" from "what was found".
    const directive = buildKnowledgeRetrievalDirective({ scope: knowledgeScope, result: knowledgeResult });
    const knowledgeFactsBlock = knowledgeResult ? buildRetrievedKnowledgeBlock({ result: knowledgeResult }) : undefined;
    const knowledgeSection = [directive, knowledgeFactsBlock].filter(Boolean).join('\n\n');

    // 启用与否由用户设置里的「联网搜索」开关（enableWebSearch）控制。
    const factualSignal = /最新|最近|今天|现在|何时|谁|哪个|什么是|多少|价格|发布|更新|新闻|行情|汇率|天气|对比|排名|当前/i.test(safeMessage);
    const webEnabled = opts?.enableWebSearch !== false;
    let webSection: string | undefined;
    let webStatus: string | undefined;
    if (!webEnabled) {
      // 如实告知当前状态：避免模型把「开关关了」说成「我无法访问网络」
      webStatus = '## 联网搜索状态\n用户已在设置中关闭联网搜索。不要声称自己不具备联网能力；需要实时信息时，直接说明「你已关闭联网搜索」并提示可在设置中开启。';
    } else if (classification.knowledge_required || factualSignal) {
      const hits = await Promise.race<SearchResult[]>([
        webSearch(safeMessage, { maxResults: 4 }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('web search timeout')), 5000)),
      ]).catch(() => null);
      if (hits?.length) {
        webSection = `## 实时网络检索结果（回答请依据以下资料并在结尾列出来源 URL）\n${hits.map((h, i) => `${i + 1}. ${h.title}\n   来源: ${h.url}\n   摘要: ${h.snippet}`).join('\n')}`;
      } else {
        webStatus = '## 联网搜索状态\n本次已尝试实时检索，但没有取回可用结果。请如实说明「本次未检索到可靠的实时来源」，不要笼统回答「我无法访问网络」，也不要编造来源。';
      }
    }
    const evidenceSection = [knowledgeSection, webSection, webStatus].filter(Boolean).join('\n\n');
    const politicalSection = politicalCheck.neutralMode ? buildPoliticalSection(politicalCheck) : undefined;

    const composition = await composePrompt(conflictResult.final_atoms, {
      ...runtimeContext,
      knowledge_required: classification.knowledge_required,
      verification_required: classification.verification_required,
      output_type: classification.output_type,
      depth: classification.depth,
    }, {
      knowledgeSection: evidenceSection || undefined,
      userContentSection: politicalSection,
    });

    // Step 11: Build model request with capability clamping
    const modelRequest = await buildModelRequest(
      composition.final_prompt,
      safeMessage,
      targetModel,
      {
        temperature,
        topP: generationProfile.temperature > 0.8 ? 0.95 : 0.90,
        stream: true,
      },
    );

    // Clamp temperature to model capability
    const cap = await getModelCapability(targetModel);
    modelRequest.temperature = clampTemperature(modelRequest.temperature, cap);

    // Step 12: Save trace
    await saveTrace({
      traceId,
      requestId: opts?.requestId,
      userId: opts?.userId,
      scenarioId: classification.scenarios[0] || null,
      task: classification.tasks.join(','),
      selected_atoms: composition.selected_atoms,
      removed_atoms: composition.removed_atoms,
      conflicts: conflictResult.conflicts,
      dependencies: { resolved: depResult.resolved_atoms, missing: depResult.missing_deps },
      knowledge_state: knowledgeResult ? knowledgeResult.confidence : 'not_required',
      verification_state: classification.verification_required ? 'required' : 'not_required',
      final_prompt_hash: composition.composition_hash,
      target_model: targetModel,
      status: 'composed',
      duration_ms: Date.now() - startTime,
      metadata: {
        generation_profile: generationProfile,
        temperature: modelRequest.temperature,
        injection_check: injectionCheck,
        political_check: politicalCheck,
        knowledge_result: knowledgeResult ? { source: knowledgeResult.source, confidence: knowledgeResult.confidence, coverage: knowledgeResult.coverage } : null,
      },
    }).catch(() => {});

    return {
      composition,
      dependencyResult: depResult,
      conflictResult,
      analysis,
      classification,
      generationProfile,
      knowledgeResult,
      knowledgeScope,
      injectionCheck,
      politicalCheck,
      runtimeContext,
      modelRequest,
      temperature: modelRequest.temperature,
      targetModel,
      retryCount,
      traceId,
      compositionHash: composition.composition_hash,
      scenarioRuntime,
    };
  } catch (err: any) {
    console.error('[PromptRuntime] Error:', err.message);
    await saveTrace({
      traceId,
      requestId: opts?.requestId,
      userId: opts?.userId,
      selected_atoms: [],
      removed_atoms: [],
      status: 'failed',
      error_message: err.message,
      final_prompt_hash: '',
      duration_ms: Date.now() - startTime,
    }).catch(() => {});
    throw err;
  }
}

// ==================== Adaptive Generation (Retry Loop) ====================

export interface GeneratedResult {
  content: string;
  usedModel: string;
  tokens: number;
  validation: OutputValidationResult;
  retryCount: number;
  finalTemperature: number;
}

export async function runWithAdaptiveRetry(
  runtime: PromptRuntimeResult,
  generator: (req: ModelRequest, attempt: number, temp?: number) => Promise<{ content: string; usedModel: string; tokens: number }>,
): Promise<GeneratedResult> {
  const maxRetries = runtime.generationProfile.retry_strategy === 'multi' ? 3 : 2;
  let attempt = 0;
  let lastContent = '';
  let lastUsedModel = runtime.targetModel;
  let lastTokens = 0;
  let currentTemp = runtime.temperature;

  while (true) {
    const req = { ...runtime.modelRequest, temperature: currentTemp };
    const result = await generator(req, attempt, currentTemp);
    lastContent = result.content;
    lastUsedModel = result.usedModel;
    lastTokens = result.tokens;

    const validation = validateOutput(
      lastContent,
      runtime.classification.output_type,
      runtime.injectionCheck.isInjection ? undefined : runtime.runtimeContext.user_message,
    );

    if (validation.passed || attempt >= maxRetries) {
      return {
        content: lastContent,
        usedModel: lastUsedModel,
        tokens: lastTokens,
        validation,
        retryCount: attempt,
        finalTemperature: currentTemp,
      };
    }

    const retryDecision = decideRetry(validation, attempt + 1, currentTemp, runtime.modelRequest.top_p);
    if (!retryDecision.shouldRetry) {
      return {
        content: lastContent,
        usedModel: lastUsedModel,
        tokens: lastTokens,
        validation,
        retryCount: attempt,
        finalTemperature: currentTemp,
      };
    }

    currentTemp = retryDecision.adjustedTemperature ?? currentTemp;
    attempt++;
  }
}

// ==================== Trace ====================

interface TraceData {
  traceId: string;
  requestId?: string;
  userId?: string;
  scenarioId?: string | null;
  task?: string | null;
  selected_atoms: string[];
  removed_atoms: string[];
  conflicts?: any;
  dependencies?: any;
  knowledge_state?: string | null;
  knowledge_sources?: any;
  verification_state?: string | null;
  final_prompt_hash: string;
  target_model?: string | null;
  status: string;
  error_message?: string | null;
  duration_ms?: number | null;
  metadata?: any;
}

async function saveTrace(data: TraceData): Promise<void> {
  try {
    await prismaKnowledge.promptTrace.create({
      data: {
        id: randomUUID(),
        traceId: data.traceId,
        requestId: data.requestId || data.traceId,
        userId: data.userId || null,
        scenarioId: data.scenarioId || null,
        task: data.task || null,
        selected_atoms: JSON.stringify(data.selected_atoms),
        atom_versions: data.metadata,
        removed_atoms: JSON.stringify(data.removed_atoms),
        conflicts: data.conflicts,
        dependencies: data.dependencies,
        knowledge_state: data.knowledge_state || null,
        knowledge_sources: data.knowledge_sources || null,
        verification_state: data.verification_state || null,
        final_prompt_hash: data.final_prompt_hash,
        target_model: data.target_model || null,
        status: data.status,
        error_message: data.error_message || null,
        duration_ms: data.duration_ms || null,
      },
    });
  } catch {
    // Trace save is non-critical
  }
}

// ==================== Task → Atom Fallback Resolver ====================
// When Gemini returns task types but no matching atoms, find published
// atoms whose category or tags match the task type.

const TASK_TO_CATEGORY_MAP: Record<string, string[]> = {
  recommendation: ['task', 'recommendation'],
  personalized_recommendation: ['task', 'recommendation'],
  multi_option: ['task', 'multi_option'],
  comparison: ['task', 'comparison'],
  decision_support: ['task', 'decision'],
  planning: ['task', 'planning'],
  brainstorming: ['task', 'brainstorm'],
  ideation: ['task', 'brainstorm'],
  writing: ['task', 'writing'],
  creative_writing: ['task', 'writing', 'creative'],
  translation: ['task', 'translation'],
  localization: ['task', 'localization'],
  calculation: ['task', 'math'],
  mathematical_reasoning: ['task', 'math'],
  data_analysis: ['task', 'data'],
  code_generation: ['task', 'code'],
  code_debugging: ['task', 'code'],
  code_review: ['task', 'code'],
  code_refactoring: ['task', 'code'],
  file_analysis: ['task', 'file'],
  image_analysis: ['task', 'file', 'image'],
  research: ['task', 'research'],
  deep_research: ['task', 'research'],
  fact_check: ['verification', 'research'],
  verification: ['verification'],
  summarization: ['task', 'summary'],
  synthesis: ['task', 'synthesis'],
  risk_analysis: ['task', 'risk'],
  compliance_check: ['task', 'compliance'],
  tutoring: ['task', 'instruction'],
  learning: ['task', 'instruction'],
};

async function resolveTaskAtomFallback(tasks: string[], candidateAtoms: Set<string>): Promise<void> {
  const categories = new Set<string>();
  for (const task of tasks) {
    const mapped = TASK_TO_CATEGORY_MAP[task];
    if (mapped) {
      for (const c of mapped) categories.add(c);
    }
  }
  if (categories.size === 0) return;

  try {
    const matchingAtoms = await prismaKnowledge.promptAtom.findMany({
      where: {
        status: 'published',
        OR: [
          ...[...categories].map(c => ({ category: c })),
          ...[...categories].map(c => ({ tags: { contains: c } })),
        ],
      },
      select: { id: true },
      take: 20,
    });
    for (const atom of matchingAtoms) {
      candidateAtoms.add(atom.id);
    }
  } catch {
    // DB unavailable — skip fallback
  }
}
