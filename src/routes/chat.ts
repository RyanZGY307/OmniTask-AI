import { Router, Response } from 'express';
import { prisma, prismaConversation } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { checkDailyLimit, incrementDailyUsage, deductCredits } from '../services/credits';
import { processTokenUsage } from '../services/billing/tokenUsage';
import { getDynamicModels } from '../services/configSync';
import { chatWithFallback } from '../services/models';
import { MODEL_REGISTRY } from '../config';
import { chatQueue } from '../services/chatQueue';
import { buildModelContext, evaluateStorageCompression, COMPRESSION_STATUS_TEXT } from '../services/memoryManager';

// Human-readable labels for model_switch SSE events. Falls back to the
// raw key when a model is not in the registry (dynamic provider models).
function displayModel(key: string): string {
  return (MODEL_REGISTRY as Record<string, any>)[key]?.displayName || key;
}
import { getRelevantChunks } from '../services/rag';
import { getMemories } from '../services/memory';
import { maybeGenerateConversationTitle } from '../services/conversationTitle';
import { routeModel, recordRoutingResult, recordRoutingFallback, recordRoutingRateLimit, recordRoutingTimeout } from '../services/router';
import { getApiKey } from '../services/apiKeyPool';
import { awaitAcquireRateGate } from '../services/rateGate';
import { evaluateSensitivity, issueSafetyRefusal, registerTopicOccurrence, MAX_MEDIUM_WARNINGS } from '../services/sensitiveGuard';
// 模型自动选择子系统已删除（routeScenario 不再用于选模型）；用户意图分析在
// buildAgentChat 上游的 classifyTask 中独立保留，用于提示词/技能构建。
import { enqueueM5Outcome } from '../services/modelEvolution/m5Outcome';

// Fire-and-forget M5 outcome enqueue. Called after the main response
// completes; the M5 worker chains M6 attribution itself when M5
// produces a non-uncertain signal. Never blocks or fails the request.
function enqueueM5OutcomeFireAndForget(
  userId: string,
  agent: { routingSource: 'scenario' | 'legacy'; scenarioRoutingId: string | null; modelKey: string },
  args: {
    usedModel: string;
    fallbackUsed: boolean;
    verificationPassed: boolean;
    originalRequest: string;
    fullContent: string;
    promptSummary?: string;
    skillIds?: string[];
  },
): void {
  if (agent.routingSource !== 'scenario' || !agent.scenarioRoutingId) return;
  const job = enqueueM5Outcome({
    modelId: args.usedModel,
    scenarioId: agent.scenarioRoutingId,
    userId,
    trigger: 'response_completed',
    originalRequest: args.originalRequest.slice(0, 4000),
    followUp: '',
    previousOutputSummary: args.fullContent.slice(0, 1000),
    verificationPassed: args.verificationPassed,
    fallbackUsed: args.fallbackUsed,
    promptSummary: args.promptSummary,
    skillIds: args.skillIds,
  });
  void (job || Promise.resolve(null)).catch((err: any) => {
    console.warn('[Chat] M5 outcome enqueue failed:', err?.message);
  });
}
import { deepResearch } from '../services/research';
import {
  newTraceId, newRequestId, createTrace, addEvent,
  addModelCall, addError, completeTrace, StreamTimer,
} from '../services/trace';
import { compilePrompt, discoverSkills } from '../services/compiler';
import { selectSkills, SKILL_HARD_CAP } from '../services/skillSelector';
import { runPromptRuntime } from '../services/promptRuntime';
import { classifyTask } from '../services/taskClassifier';
import { computeTemperature } from '../services/generationProfile';
import { getModelCapability, clampTemperature } from '../services/modelCapabilityRegistry';
import { verifyResponse } from '../services/verification';
import { createSession, addSessionEvent, updateSession } from '../services/sessionState';
import * as memoryRuntime from '../services/memoryRuntime';  // NEW
import { runUserCuration } from '../services/userCuration';
import { analyzeMediaIntent } from '../services/agnes';
import { analyzeAudioGenerationIntent } from '../services/audio/intent';
import { TTS_MODELS } from '../services/audio/ttsRegistry';
import { analyzeOfficeGenerationIntent, type OfficeGateResult } from '../services/office/intent';

// Default output format per office artifact type — single source of truth.
// The spec card shows this as the pre-selected format; the user can change it.
function defaultFormatFor(artifactType?: string): string {
  switch (artifactType) {
    case 'presentation': return 'pptx';
    case 'spreadsheet': return 'xlsx';
    case 'document':
    case 'pdf':
    default: return 'docx';
  }
}
import { routeKnowledgeScope, type KnowledgeScope } from '../services/knowledgeScopeRouter';
import { queryKnowledge } from '../services/knowledgeRuntime';
import { writeMemory, retrieveContext } from '../services/contextMemory/runtime';
import { enqueueCompression, evaluateCompressionTrigger } from '../services/contextMemory/compression';
import { extractEvents, buildContextAwareIntent } from '../services/contextMemory/extract';
import type { ContextAwareIntentResult } from '../services/contextMemory/types';
import { renderUserSkillsBlock } from '../services/userSkillInstall';
import { isContextCompressionEnabled, compactInstalledSkillsBlock, compactRagChunks } from '../services/context/compress';

// Render the Context Package (P0–P7, superseded-filtered) into a compact
// section that the prompt compiler + context-aware intent layer can consume.
// P0 (the current user message) is never re-summarized here — it is always
// passed verbatim by the caller; this section only carries P1..P7.
function buildContextMemorySection(pkg: any): string {
  if (!pkg) return '';
  const parts: string[] = [];
  const active = pkg.activeTask;
  if (active?.task) {
    const constraints = Array.isArray(active.constraints) && active.constraints.length ? ` constraints: ${active.constraints.join(', ')}` : '';
    parts.push(`Active task: ${active.task}${active.stage ? ` (stage: ${active.stage})` : ''}${active.status ? ` [${active.status}]` : ''}${active.currentGoal ? ` — goal: ${active.currentGoal}` : ''}${constraints}`);
  }
  if (pkg.requirements?.length) parts.push(`Recent requirements:\n- ${pkg.requirements.slice(0, 5).join('\n- ')}`);
  if (pkg.preferences?.length) parts.push(`Preferences:\n- ${pkg.preferences.slice(0, 5).join('\n- ')}`);
  if (pkg.decisions?.length) parts.push(`Decisions:\n- ${pkg.decisions.slice(0, 5).join('\n- ')}`);
  if (pkg.corrections?.length) {
    parts.push(`Open corrections:\n- ${pkg.corrections.slice(0, 5).map((c: any) => `${c.kind} (status ${c.status})${c.userClaim ? `: ${c.userClaim}` : ''}`).join('\n- ')}`);
  }
  if (pkg.facts?.length) parts.push(`Durable facts:\n- ${pkg.facts.slice(0, 5).join('\n- ')}`);
  if (pkg.compressedHistory) parts.push(`Compressed history: ${pkg.compressedHistory.slice(0, 2000)}`);
  if (parts.length === 0) return '';
  return `[Context Memory]\n${parts.join('\n')}`;
}


// 把 office 意图里的「引用既有文件」解析成真实 artifact id。
// 选择规则：限定当前用户（可选同会话）的已完成文件，优先未被取代的版本；
// targetRef.index 表示“第 N 个”（1 起）。
async function resolveOfficeArtifactId(
  userId: string,
  conversationId: string | null,
  targetRef?: { index?: number } | null,
): Promise<string | undefined> {
  try {
    const list = await prisma.officeArtifact.findMany({
      where: { userId, status: 'completed', ...(conversationId ? { conversationId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, supersededBy: true },
    });
    const active = list.filter((a) => !a.supersededBy);
    const pool = active.length > 0 ? active : list;
    const idx = typeof targetRef?.index === 'number' && targetRef.index > 0 ? targetRef.index - 1 : 0;
    return pool[idx]?.id;
  } catch {
    return undefined;
  }
}

const router = Router();

// 知识时效性指引：模型训练数据有截止日期，对"最新/当前"类事实问题
// 若检索知识库无证据，必须显式说明无法核实，而非把过时数据当成现状。
function buildKnowledgeTimelinessBlock(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `[Knowledge Timeliness]
Today is ${today}. Your training data has a knowledge cutoff and may be outdated for recent events, product releases, software versions and news.
- If a retrieved knowledge block above contains relevant facts, use them and mention that they come from the knowledge base.
- When asked about "latest / current / newest / 最新" facts and no retrieved evidence is available, explicitly say you cannot verify the current state and state the approximate period your knowledge covers.
- Do not state specific version numbers, release dates, or product names as current unless you have retrieved evidence or high confidence they predate your cutoff.`;
}

// ================================================================
// Helper: build chat with Agent Runtime + Memory Runtime
// ================================================================
async function buildAgentChat(
  userId: string,
  user: any,
  message: string,
  mode: string | undefined,
  requestedModel: string | undefined,
  conversationHistory: { role: string; content: string }[],
  traceId: string,
  conversationId?: string,
) {
  const taskClassification = classifyTask(message, mode);
  const session = createSession(userId, taskClassification.suggestedAgent, taskClassification.taskType);
  addSessionEvent(session.sessionId, 'task_classified', taskClassification);

  // Legacy model selection (cheap synchronous rule pass). When the scenario
  // router flag is on (default) this decision is replaced below after the
  // prompt runtime resolves the P2 scenario id; with the flag off it stays
  // authoritative and behavior is unchanged.
  let decision: any = routeModel(user, requestedModel, mode, taskClassification);
  let scenarioRoutingId: string | null = null;
  let routingSource: 'scenario' | 'legacy' = 'legacy';
  let modelKey = decision.model;
  let modelInfo = (getDynamicModels() as any)[modelKey];

  // ============================================================
  // Temperature Engine — final temperature decision-maker.
  // Runs AFTER the Router has selected the model; it is clamped
  // to the target model's capability bounds. Serves as the
  // authoritative fallback when PromptRuntime degrades so the
  // temperature source is never a hardcoded constant.
  // ============================================================
  const taskToTempInput = (tc: any) => ({
    tasks: [tc.taskType],
    creativity: tc.taskType === 'writing' ? 3 : tc.taskType === 'coding' ? 1 : 2,
    accuracy: tc.needsVerification ? 'high' : 'medium',
    exploration: 0.5, diversity: 0.5, structure: 0.5, consistency: 0.5,
    risk: tc.taskType === 'research' || tc.taskType === 'complex' ? 'medium' : 'low',
    verification: !!tc.needsVerification,
    targetModel: modelKey,
  });
  let resolvedTemperature: number;
  try {
    const profile = computeTemperature(taskToTempInput(taskClassification));
    const cap = await getModelCapability(modelKey);
    resolvedTemperature = clampTemperature(profile.temperature, cap);
  } catch {
    resolvedTemperature = 0.7;
  }

  // Load context — each source is gated by what the task actually needs:
  // - Legacy task-relevant memory (getMemories) → only when task needs memory
  // - Legacy RAG (getRelevantChunks) → only when task needs knowledge retrieval
  // - Memory Runtime (beforeResponse) → always runs: it is the system context
  //   engine (calibration / expression / domain profile) that the main answer
  //   path depends on. The task-relevant slice of its output (relevantMemories)
  //   is still consumed, but the engine itself is not a per-task optional.
  // Prompt Runtime's Knowledge Runtime performs its own knowledge retrieval
  // when classification.knowledge_required; the legacy RAG feed is a
  // supplementary source, so it is skipped for tasks that don't need
  // knowledge (simple_chat / question / coding / math / writing / translation
  // rarely reference the curated KB, whereas research / analysis / planning
  // / complex do).
  const needsKnowledge = taskClassification.taskType === 'research'
    || taskClassification.taskType === 'analysis'
    || taskClassification.taskType === 'planning'
    || taskClassification.taskType === 'complex';
  const memories = taskClassification.needsMemory
    ? await getMemories(userId).catch(() => [])
    : [];
  const ragChunks = needsKnowledge
    ? await getRelevantChunks(message, userId).catch(() => [])
    : [];
  const memoryContext = await memoryRuntime.beforeResponse(userId, message, conversationId || 'new', user.language).catch(() => null);

  // ===== Context-Aware Intent: retrieve the budget-aware context package
  // (P0 current message is passed by the caller; P1..P7 come from the store).
  // Pure rule/DB read — millisecond budget, no LLM. Feeds the context-aware
  // intent analysis below without replacing the existing Scenario runtime.
  let contextPackage: any = null;
  try {
    const cmTier = user.subscriptionTier || 'FREE';
    contextPackage = await retrieveContext(userId, conversationId || 'new', cmTier).catch(() => null);
  } catch {
    contextPackage = null;
  }
  const contextMemorySection = buildContextMemorySection(contextPackage);

  // ===== Context-Aware Intent: deterministic extraction of context signals
  // (corrections, requirements, references, capability intents, task-stage
  // changes) layered ON TOP of the existing AI classification. No new AI
  // call — rule/DB only. Merged into the classification so the Scenario
  // runtime and downstream model/skill selection keep working.
  let contextIntent: ContextAwareIntentResult | null = null;
  try {
    const extraction = extractEvents({
      message,
      messageId: conversationId || 'new',
      recentHistory: conversationHistory.slice(-10),
      scenarioId: undefined,
    });
    contextIntent = buildContextAwareIntent(null, extraction, {
      scenarioStable: false,
      activeTask: contextPackage?.activeTask
        ? {
            task: contextPackage.activeTask.task,
            stage: contextPackage.activeTask.stage,
            status: contextPackage.activeTask.status,
            constraints: contextPackage.activeTask.constraints,
          }
        : null,
      openCorrections: contextPackage?.corrections ?? [],
      recentRequirements: contextPackage?.requirements ?? [],
      recentPreferences: contextPackage?.preferences ?? [],
    });
    // A factual correction detected in the realtime path escalates the
    // task to need verification (feeds the Knowledge/Verification runtime
    // without adding an AI call).
    if (contextIntent.correction.detected && contextIntent.correction.verificationRequired) {
      taskClassification.needsVerification = true;
    }
    // Media capability intents survive Context Memory: when the extractor
    // flags one, make sure the downstream media pipeline can still see it.
    if (contextIntent.capabilityIntent) {
      taskClassification.requiredCapabilities.push(contextIntent.capabilityIntent);
    }
  } catch {
    contextIntent = null;
  }

  // ===== Skill 快速选择器（零 AI 调用）=====
  // 复用现有意图分析结果（taskClassification + 意图层 requiredCapabilities），
  // 只查预计算索引；门槛不够立即 SELECT_NONE；上限 2；选择结果写入 trace。
  const skillSelection = selectSkills({
    message,
    taskType: taskClassification.taskType,
    requiredCapabilities: taskClassification.requiredCapabilities,
    userTier: user.subscriptionTier || 'STANDARD',
  });
  const skillIds = skillSelection.skillIds;
  addEvent(traceId, 'SKILL_SELECT', {
    decision: skillSelection.decision,
    skills: skillSelection.skillIds,
    reason: skillSelection.reason,
    candidates: skillSelection.candidates,
    elapsedMs: skillSelection.elapsedMs,
  }, 'info', skillSelection.elapsedMs).catch(() => {});

  // Merge memories: existing + new memory runtime + Context Memory (P0–P7).
  // Context Memory entries are the budget-aware, priority-ordered slice of
  // "what happened before" — corrections, requirements, decisions, facts,
  // compressed history — that the context-aware intent layer needs.
  const allMemories = [
    ...memories.map((m: any) => ({ category: m.category, content: m.content })),
    ...(memoryContext?.relevantMemories || []),
    ...(contextMemorySection ? [{ category: 'context_memory', content: contextMemorySection }] : []),
  ];

  // Primary: Prompt Runtime (Gemini analysis → atom selection → composition)
  // 「联网搜索」开关（设置页）决定是否做网络预检索；读取失败按默认开处理。
  const userSetting = await prisma.userSetting.findUnique({ where: { userId } }).catch(() => null);
  let prResult: any = null;
  try {
    prResult = await runPromptRuntime(message, conversationHistory, {
      language: user.language,
      region: user.region,
      userTier: user.subscriptionTier,
      targetModel: modelKey,
      userId,
      requestId: conversationId,
      enableWebSearch: userSetting?.enableSearch !== false,
    });
  } catch (err: any) {
    console.warn('[Chat] PromptRuntime degraded, falling back to compiler:', err?.message);
  }

  // When the scenario-driven runtime ran successfully, its S4 skill
  // selection is authoritative (R8): the deterministic fast selector is
  // only a legacy fallback and must NOT be merged in. Empty S4 selection
  // stays []. S4 结果同样受整链硬上限约束（含子任务/重试不得绕过）。
  const scenarioSkillIds: string[] | null =
    prResult?.scenarioRuntime?.ok === true
      ? (prResult.scenarioRuntime.selectedSkillIds ?? []).slice(0, SKILL_HARD_CAP)
      : null;
  const effectiveSkillIds = scenarioSkillIds !== null ? scenarioSkillIds : skillIds;
  if (scenarioSkillIds !== null) {
    addEvent(traceId, 'SKILL_SELECT', {
      decision: scenarioSkillIds.length === 0 ? 'SELECT_NONE' : `SELECT_${scenarioSkillIds.length}`,
      source: 'S4_scenario_runtime',
      skills: scenarioSkillIds,
      overrodeFastSelector: skillSelection.skillIds,
    }, 'info').catch(() => {});
  }

  // Scenario-Driven Model Router (flag-gated; CORTX_SCENARIO_MODEL_ROUTING
  // default on, explicit 'off' keeps the legacy decision byte-identical).
  // Scenario id source: the P2-matched scenario resolved by the prompt
  // runtime; the registry's general.chat scenario is the fallback. Runs
  // after the prompt runtime because that is where P2 resolves. Router
  // failure never fails the request: the legacy decision stays.
  if (process.env.CORTX_SCENARIO_MODEL_ROUTING !== 'off') {
    const p2: any = prResult?.scenarioRuntime?.p2;
    scenarioRoutingId = p2?.matched_scenario_id || 'general.chat';
    // 模型自动选择子系统已删除：场景路由不再覆盖模型选择。
    // 模型由 routeModel 决定（全用户手动选择直接调用；未选时规则默认选单一模型，限流时排队不切模型）；
    // 此处仅保留场景 id 供 M5 事件上下文记录，且不再调用 routeScenario 选模型。
    void scenarioRoutingId;
  }

  // Fallback: old compiler (used when PromptRuntime is unavailable).
  // Knowledge Scope Router runs here ONLY on the compiler path (Prompt
  // Runtime already does its own scoped retrieval internally). It is
  // best-effort: any failure degrades to an unscoped compile, never to
  // a request failure.
  let knowledgeScopeForCompile: KnowledgeScope | undefined;
  let knowledgeResultForCompile: any = null;
  if (needsKnowledge && !prResult) {
    try {
      knowledgeScopeForCompile = await routeKnowledgeScope({
        message,
        taskClassification,
        region: user.region,
        needsVerification: taskClassification.needsVerification,
      });
      // Only run the Knowledge Runtime when the scope actually has a primary
      // or secondary scope to search; otherwise skip (no useful narrowing).
      if (knowledgeScopeForCompile.primaryScopes.length > 0 || knowledgeScopeForCompile.secondaryScopes.length > 0) {
        knowledgeResultForCompile = await queryKnowledge({
          query: message,
          region: user.region,
          scope: knowledgeScopeForCompile,
        }).catch(() => null);
      }
    } catch {
      // Scope Router / Knowledge Runtime failure must not fail the chat.
      knowledgeScopeForCompile = undefined;
      knowledgeResultForCompile = null;
    }
  }

  // Best-effort: inject this account's active, clean installed skills into
  // its model context. Never fails the chat — degrades to no block on error.
  let accountSkillsBlock = '';
  try {
    accountSkillsBlock = await renderUserSkillsBlock(userId);
  } catch {
    accountSkillsBlock = '';
  }
  // Headroom-style compaction: fold over-long per-skill prompts so a large
  // installed-skills list stops dominating the system prompt. Short blocks
  // are returned unchanged by compactInstalledSkillsBlock.
  if (accountSkillsBlock && isContextCompressionEnabled()) {
    accountSkillsBlock = compactInstalledSkillsBlock(accountSkillsBlock);
  }

  const compiled = compilePrompt({
    userId,
    userTier: user.subscriptionTier || 'STANDARD',
    userName: user.username,
    message,
    taskClassification,
    mode,
    memories: allMemories,
    ragChunks: isContextCompressionEnabled() ? compactRagChunks(ragChunks) : ragChunks,
    conversationHistory,
    region: user.region,
    language: user.language,
    calibration: memoryContext?.calibration,
    expressionSection: memoryContext?.expressionSection,
    knowledgeScope: knowledgeScopeForCompile,
    knowledgeResult: knowledgeResultForCompile,
  });

  // Use PromptRuntime system prompt if available, otherwise fall back
  const baseSystemPrompt = prResult?.composition?.final_prompt || compiled.system;
  const finalSystemPrompt =
    baseSystemPrompt +
    (accountSkillsBlock ? '\n\n---\n\n' + accountSkillsBlock : '') +
    '\n\n---\n\n' + buildKnowledgeTimelinessBlock();
  // ===== 统一对话记忆管理：上下文拼装唯一出口 =====
  // 旧代码：[{system}, ...conversationHistory, {user}] —— 历史全量进上下文，
  // 不看 Token、不读摘要、不触发压缩。接入点唯一（Chat 与 Agent 共用本函数），
  // 因此在这里替换即可覆盖两个入口，同时消除 slice(-20)/slice(-10)/slice(-5)
  // 等多处口径不一致。
  //
  // 压缩只影响"后台任务"与"未来的请求"；本次请求仍用当前可用上下文返回，
  // 不被后台任务阻塞。新对话（conversationId 未落库）走 fallbackHistory。
  const contextPlan = await buildModelContext({
    conversationId: conversationId && conversationId !== 'new' ? conversationId : '',
    userId,
    systemPrompt: finalSystemPrompt,
    fixedPrompts: contextMemorySection || undefined,
    currentRequest: message,
    toolDefinitions: effectiveSkillIds?.length ? JSON.stringify(effectiveSkillIds) : undefined,
    modelKey,
    fallbackHistory: conversationHistory,
  }).catch(() => null);

  const chatMessages = contextPlan
    ? contextPlan.messages
    : [
        { role: 'system', content: finalSystemPrompt },
        ...conversationHistory,
        { role: 'user', content: message },
      ];
  // 上下文预算与压缩状态：供观测与 SSE 状态提示；缺失时不影响主流程
  const contextBudget = contextPlan?.budget ?? null;
  const activeCompressionTaskId = contextPlan?.activeCompressionTaskId ?? null;

  addSessionEvent(session.sessionId, 'prompt_compiled', {
    ...(prResult ? { source: 'prompt_runtime', trace_id: prResult.traceId, composition_hash: prResult.compositionHash, scenario: prResult.analysis.scenario, selected_atoms: prResult.composition.selected_atoms } : { source: 'compiler', ...compiled.metadata }),
  });

  addSessionEvent(session.sessionId, 'prompt_compiled', compiled.metadata);

  await addEvent(traceId, 'VALIDATION', {
    taskType: taskClassification.taskType,
    complexity: taskClassification.complexity,
    agent: taskClassification.suggestedAgent,
    skills: effectiveSkillIds,
    confidence: taskClassification.confidence,
  }, 'success');

  await addEvent(traceId, 'REQUEST', {
    source: prResult ? 'prompt_runtime' : 'compiler',
    trace_id: prResult?.traceId,
    composition_hash: prResult?.compositionHash,
    scenario: prResult?.analysis?.scenario,
    selected_atoms: prResult?.composition?.selected_atoms,
    removed_atoms: prResult?.composition?.removed_atoms,
    conflicts: prResult?.conflictResult?.conflicts,
    // 该字段是**提示词大小的粗估**（chars/3），用于 prompt 运行时可观测，
    // 不是 token 消耗统计，也不参与扣费。字段名带 _estimated 以正名：
    // 观测面板上的任何数字都该能自证是实测还是估算。
    system_tokens_estimated: Math.ceil(finalSystemPrompt.length / 3),
  }, prResult ? 'success' : 'degraded');

  await addEvent(traceId, 'VALIDATION', {
    agent: compiled.metadata.agent,
    skills: compiled.metadata.skills,
    systemTokens: compiled.metadata.totalSystemTokens,
    breakdown: {
      kernel: compiled.metadata.kernelTokens,
      agent: compiled.metadata.agentTokens,
      skills: compiled.metadata.skillTokens,
      memory: compiled.metadata.memoryTokens,
      rag: compiled.metadata.ragTokens,
      calibration: compiled.metadata.calibrationTokens,
    },
    domainLevel: memoryContext?.calibration?.domainLevel,
    languageLevel: memoryContext?.calibration?.languageLevel,
  }, 'success');

  await addEvent(traceId, 'ROUTER', {
    selectedModel: modelKey,
    reason: decision.reason,
    fallbacks: decision.fallbacks,
    candidateCount: decision.telemetry.candidateCount,
    filteredCount: decision.telemetry.filteredCount,
    scores: decision.telemetry.scores,
    filterReasons: decision.telemetry.filterReasons,
    qualityFloor: decision.telemetry.qualityFloor,
    fastPath: decision.telemetry.fastPath,
    scoringWeights: decision.telemetry.scoringWeights,
  }, 'success');

  if (ragChunks.length > 0) {
    await addEvent(traceId, 'RETRIEVAL', { chunkCount: ragChunks.length }, 'success');
  }

  if (memoryContext?.domainProfile) {
    await addEvent(traceId, 'RETRIEVAL', {
      domain: memoryContext.domainInfo.domain,
      domainLevel: memoryContext.calibration.domainLevel,
      languageLevel: memoryContext.calibration.languageLevel,
      memoryCount: allMemories.length,
    }, 'success');
  }

  updateSession(session.sessionId, { status: 'running', currentPhase: 'execution' });

  // 自动排队：被选中的模型若受速率限制则等待放行（免费版轮询已预占闸门则跳过）。
  // Pro 手动选择/兜底模型被限流时最多等 20s；硬阻断则标记 queueBlocked，SSE 层优雅降级。
  if (!decision.release) {
    const qProvider = decision.provider || modelInfo?.provider;
    const qTier: 'FREE' | 'PRO' = decision.tier === 'PRO' ? 'PRO' : 'FREE';
    const qKey = qProvider ? getApiKey(qProvider, qTier) : null;
    if (qProvider && qKey) {
      const q = await awaitAcquireRateGate(
        { provider: qProvider, tier: qTier, apiKey: qKey, modelKey, estTokens: taskClassification.estimatedTokens ?? 1000 },
        20_000,
      );
      if (q.ok) {
        decision.release = q.release;
        (decision as any).queuedMs = q.queuedMs;
      } else if (q.blocked) {
        (decision as any).queueBlocked = true;
      } else {
        (decision as any).queueTimedOut = true;
      }
    }
  }

  return {
    chatMessages,
    modelKey, modelInfo, decision, taskClassification,
    skillIds: effectiveSkillIds, session, compiled, memories, ragChunks, memoryContext,
    promptRuntime: prResult,
    resolvedTemperature,
    routingSource, scenarioRoutingId,
    // 上下文预算与压缩状态（供 SSE 提示与观测；不影响主流程）
    contextBudget, activeCompressionTaskId,
  };
}

// ================================================================
// GET / — list conversations
// ================================================================
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const page = parseInt(String(req.query.page)) || 1;
    const limit = parseInt(String(req.query.limit)) || 20;
    const search = String(req.query.search || '');
    const skip = (page - 1) * limit;
    const where: any = { userId };
    if (search) where.title = { contains: search };

    const [conversations, total] = await Promise.all([
      prismaConversation.conversation.findMany({
        where, skip, take: limit,
        orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }],
        include: { _count: { select: { messages: true } } },
      }),
      prismaConversation.conversation.count({ where }),
    ]);

    res.json({ conversations, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('List conversations error:', err);
    res.status(500).json({ error: '获取对话列表失败' });
  }
});

// ================================================================
// POST / — create conversation + first message (SSE)
// ================================================================
router.post('/', authMiddleware, rateLimit(60000, 30), async (req: AuthRequest, res: Response) => {
  const traceId = newTraceId();
  const requestId = newRequestId();
  const timer = new StreamTimer();

  try {
    const userId = req.user!.id;
    const { model: requestedModel, mode } = req.body;
    const message = req.body.message || req.body.content;
    if (!message) {
      const conversation = await prismaConversation.conversation.create({ data: { userId, title: '新对话' } });
      return res.json({ conversation });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: '用户不存在' });

    // ===== Safety Gate — 敏感拦截，先于媒体/文档/研究分发 =====
    // 高敏感直拒 + 落档；中敏感计警告并继续正常分发（本路由必为新会话）
    let safetyWarningForReply = 0;
    let safetyTopicsForReply: string[] = [];
    const safetyVerdict = evaluateSensitivity(message);
    if (safetyVerdict.level === 'high') {
      const refuse = await issueSafetyRefusal({
        userId, username: user.username, conversation: null, message,
        level: 'high', labels: safetyVerdict.labels, warningCount: 1, model: requestedModel,
      });
      return res.json({ type: 'safety_refusal', conversation: { id: refuse.conversation.id }, refusalMessage: refuse.refusalMessage });
    } else if (safetyVerdict.level === 'medium') {
      // 新会话尚无历史，同一受限事项首次出现 → 第 1 次警告
      safetyWarningForReply = 1;
      safetyTopicsForReply = safetyVerdict.labels;
    }

    // 新会话路径下敏感警告的落地种子：提前返回的分支（媒体/音频/office/研究）
    // 也建会话，必须带上同一受限事项的历史，否则警告会被静默丢弃。
    const safetyConvSeed = {
      safetyWarnings: safetyWarningForReply,
      ...(safetyTopicsForReply.length ? { safetyTopicHistory: JSON.stringify([safetyTopicsForReply]) } : {}),
    };

    // ===== Media Intent — first gate for every user message =====
    // Runs before research/think dispatch so that a message asking to
    // generate media is never accidentally routed into a text pipeline.
    const mediaIntentFirst = await analyzeMediaIntent(message);
    if (mediaIntentFirst.intent === 'image-gen' || mediaIntentFirst.intent === 'video-gen') {
      const p = mediaIntentFirst.params;
      const conv = await prismaConversation.conversation.create({ data: { userId, title: message.substring(0, 50), ...safetyConvSeed } });
      const confirmMeta = {
        kind: mediaIntentFirst.intent,
        status: 'pending',
        prompt: mediaIntentFirst.prompt,
        params: {
          model: p.model || (mediaIntentFirst.intent === 'image-gen' ? 'agnes-image-2.5-flash' : 'agnes-video-2.5-flash'),
          ratio: p.ratio,
          resolution: p.resolution,
          seconds: p.seconds,
        },
      };
      await prismaConversation.message.create({ data: { conversationId: conv.id, role: 'user', content: message, messageType: 'text' } });
      const confirmMsg = await prismaConversation.message.create({
        data: {
          conversationId: conv.id, role: 'assistant',
          content: mediaIntentFirst.prompt,
          messageType: 'media_confirm',
          metadata: JSON.stringify(confirmMeta),
        },
      });
      res.json({
        type: 'media_confirm',
        conversation: { id: conv.id },
        confirmMessage: { id: confirmMsg.id, messageType: 'media_confirm', content: mediaIntentFirst.prompt, metadata: confirmMeta, createdAt: confirmMsg.createdAt },
      });
      return;
    }

    // ===== Audio Generation Intent — deterministic gate, no new AI call =====
    // "什么是 TTS？" / "分析这个音频" / "MiMo 支持哪些格式" do NOT open
    // the card; only a true generation request does (auto-fill from the
    // message + Context Reference for "用刚才那个声音").
    const audioGate = analyzeAudioGenerationIntent({ message });
    if (audioGate.shouldOpenAudioCard) {
      const conv = await prismaConversation.conversation.create({ data: { userId, title: message.substring(0, 50), ...safetyConvSeed } });
      const defaultAudioModel = TTS_MODELS[0].modelId;
      const audioConfirmMeta = {
        kind: 'audio-gen',
        status: 'pending',
        prompt: audioGate.autoFill?.spokenText || audioGate.autoFill?.contentOverview || message,
        params: {
          model: defaultAudioModel,
          format: TTS_MODELS[0].defaultFormat,
          voiceDesign: audioGate.autoFill?.voiceDesign || undefined,
          contentOverview: audioGate.autoFill?.contentOverview || audioGate.autoFill?.spokenText,
          spokenText: audioGate.autoFill?.spokenText || undefined,
          styleInstruction: audioGate.autoFill?.styleInstruction || undefined,
          voiceReferenceHint: audioGate.autoFill?.voiceReferenceHint || false,
        },
      };
      await prismaConversation.message.create({ data: { conversationId: conv.id, role: 'user', content: message, messageType: 'text' } });
      const audioConfirmMsg = await prismaConversation.message.create({
        data: {
          conversationId: conv.id, role: 'assistant',
          content: audioConfirmMeta.prompt,
          messageType: 'media_confirm',
          metadata: JSON.stringify(audioConfirmMeta),
        },
      });
      res.json({
        type: 'media_confirm',
        conversation: { id: conv.id },
        confirmMessage: { id: audioConfirmMsg.id, messageType: 'media_confirm', content: audioConfirmMeta.prompt, metadata: audioConfirmMeta, createdAt: audioConfirmMsg.createdAt },
      });
      return;
    }

    // ===== Office / Document Generation Intent — deterministic gate =====
    // "帮我做一份 10 页的 AI 入门 PPT" / "生成正式 PRD，DOCX" / "做个销售 Excel"
    // open the office spec card. Bare discussion ("PPTX 和 PPT 区别？") does NOT.
    const officeGate = analyzeOfficeGenerationIntent({ message });
    if (officeGate.shouldOpenCard && officeGate.kind) {
      const conv = await prismaConversation.conversation.create({ data: { userId, title: message.substring(0, 50), ...safetyConvSeed } });
      const af = officeGate.autoFill ?? {};
      // 引用既有文件时解析成真实 artifact id（归属由 userId 限定）
      const sourceArtifactId = af.sourceArtifactHint
        ? await resolveOfficeArtifactId(userId, null, af.targetRef)
        : undefined;
      const officeConfirmMeta = {
        kind: 'office-gen',
        status: 'pending',
        prompt: af.contentOverview || message,
        params: {
          artifactType: af.artifactType || officeGate.kind,
          format: af.format || defaultFormatFor(af.artifactType || officeGate.kind),
          contentOverview: af.contentOverview,
          title: af.title || undefined,
          audience: af.audience || undefined,
          pageOrSlideCount: af.pageOrSlideCount,
          documentType: af.documentType || undefined,
          style: af.style || undefined,
          sourceArtifactId,
          operation: af.operation || 'generate',
          targetRef: af.targetRef || undefined,
        },
      };
      await prismaConversation.message.create({ data: { conversationId: conv.id, role: 'user', content: message, messageType: 'text' } });
      const officeConfirmMsg = await prismaConversation.message.create({
        data: {
          conversationId: conv.id, role: 'assistant',
          content: officeConfirmMeta.prompt,
          messageType: 'media_confirm',
          metadata: JSON.stringify(officeConfirmMeta),
        },
      });
      res.json({
        type: 'media_confirm',
        conversation: { id: conv.id },
        confirmMessage: { id: officeConfirmMsg.id, messageType: 'media_confirm', content: officeConfirmMeta.prompt, metadata: officeConfirmMeta, createdAt: officeConfirmMsg.createdAt },
      });
      return;
    }

    if (mode === 'think') {
      const limit = await checkDailyLimit(userId, 'think');
      if (!limit.allowed) {
        await createTrace({ traceId, requestId, userId, requestedModel, mode, region: user.region });
        await addError(traceId, { userId, errorType: 'rate_limit', message: '今日深度思考次数已用完', stage: 'auth', severity: 'WARN' });
        await completeTrace(traceId, { status: 'RATE_LIMITED' });
        return res.status(429).json({ error: `今日深度思考次数已用完（${limit.limit}次/天）` });
      }
    }

    if (mode === 'research') {
      const limit = await checkDailyLimit(userId, 'research');
      if (!limit.allowed) {
        await createTrace({ traceId, requestId, userId, requestedModel, mode, region: user.region });
        await addError(traceId, { userId, errorType: 'rate_limit', message: '今日研究次数已用完', stage: 'auth', severity: 'WARN' });
        await completeTrace(traceId, { status: 'RATE_LIMITED' });
        return res.status(429).json({ error: '今日研究次数已用完' });
      }

      await createTrace({ traceId, requestId, userId, requestedModel, mode: 'research', region: user.region });
      await addEvent(traceId, 'REQUEST', { type: 'research', message: message.substring(0, 200) });

      const result = await deepResearch(message, userId, user.region || undefined);
      await incrementDailyUsage(userId, 'research');

      const conversation = await prismaConversation.conversation.create({
        data: {
          userId, title: '新对话', ...safetyConvSeed,
          messages: {
            create: [
              { role: 'user', content: message, messageType: 'text' },
              { role: 'assistant', content: result.answer, messageType: 'text', model: 'deep-research', mode: 'research', tokenCount: result.tokensUsed || 0,
                ...(safetyWarningForReply ? { metadata: JSON.stringify({ safetyWarning: safetyWarningForReply }) } : {}) },
            ],
          },
        },
        include: { messages: true },
      });

      maybeGenerateConversationTitle(conversation.id, message).catch(() => {});

      // 真实 token：只在 provider 明确回传输入/输出时才记录；
      // 拆不了就留空（界面显示未知），不再按 70%/30% 编造拆分。
      const drTotal = result.tokensUsed || 0;
      await completeTrace(traceId, {
        status: 'SUCCESS', selectedModel: 'deep-research',
        totalTokens: drTotal,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
      });

      return res.json({ conversation, research: result });
    }

    await createTrace({ traceId, requestId, userId, requestedModel, mode, region: user.region });
    await addEvent(traceId, 'REQUEST', { requestedModel, mode, message: message.substring(0, 200) });

    // Agent Runtime + Memory Runtime
    // SSE 预连接：先建响应、立刻发 accepted 事件，再跑预处理（知识库查询/预排队），首字节即时返回
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'accepted' })}\n\n`);
    const agent = await buildAgentChat(userId, user, message, mode, requestedModel, [], traceId);

    if (!agent.modelInfo) {
      await addError(traceId, { userId, errorType: 'validation', message: `无效模型: ${agent.modelKey}`, stage: 'router', severity: 'WARN' });
      await completeTrace(traceId, { status: 'FAILED' });
      res.write(`data: ${JSON.stringify({ type: 'error', content: '无效模型' })}\n\n`);
      res.end();
      return;
    }

    const conversation = await prismaConversation.conversation.create({ data: { userId, title: '新对话', ...safetyConvSeed } });
    await prismaConversation.message.create({ data: { conversationId: conversation.id, role: 'user', content: message, messageType: 'text' } });

    // ===== Client disconnect handling =====
    // When the client aborts, stop consuming the provider stream (breaks the
    // generator → provider fetch is aborted) and stop writing to a destroyed
    // socket. Resource cleanup + finalization still run below.
    let clientDisconnected = false;
    req.on('close', () => {
      if (!res.writableEnded) clientDisconnected = true;
    });
    const safeWrite = (payload: string): void => {
      if (clientDisconnected || res.destroyed || res.writableEnded) return;
      try { res.write(payload); } catch { clientDisconnected = true; }
    };

    safeWrite(`data: ${JSON.stringify({ type: 'conversation', conversationId: conversation.id })}\n\n`);

    // ===== High Server Load / Frequency Queue Slot Acquisition =====
    let queueTicket: any = null;
    try {
      queueTicket = await chatQueue.acquireSlot({
        userId,
        requestId,
        onQueueUpdate: (info) => {
          safeWrite(`data: ${JSON.stringify({ type: 'queue', status: 'queued', ...info })}\n\n`);
        },
      });
      safeWrite(`data: ${JSON.stringify({ type: 'queue', status: 'processing' })}\n\n`);
    } catch (queueErr: any) {
      safeWrite(`data: ${JSON.stringify({ type: 'error', content: queueErr?.message || '服务器繁忙，排队失败' })}\n\n`);
      if (!clientDisconnected) res.end();
      return;
    }

    // 速率闸门（供应商/API/模型额度）：本次请求已预排队或阻断 → 告知前端
    const qd = agent.decision as any;
    if (qd?.queueBlocked) {
      safeWrite(`data: ${JSON.stringify({ type: 'model_throttled', status: 'blocked', model: agent.modelKey })}\n\n`);
    } else if (qd?.queueTimedOut) {
      safeWrite(`data: ${JSON.stringify({ type: 'model_throttled', status: 'timed_out', model: agent.modelKey })}\n\n`);
    } else if (qd?.queuedMs) {
      safeWrite(`data: ${JSON.stringify({ type: 'model_queued', ms: qd.queuedMs, model: agent.modelKey })}\n\n`);
    }

    try {
    let fullContent = '';
    let tokenCount = 0;
    let usedModel = agent.modelKey;
    let modelStart = new Date();
    let streamStarted = false;
    let firstTokenRecorded = false;
    let finishReason = 'stop';
    let providerUsage: any = null;

    await addEvent(traceId, 'MODEL', {
      provider: agent.modelInfo.provider,
      requestedModel: agent.modelKey,
      apiModel: agent.modelInfo.apiModel,
    }, 'started');

    const dynamicTemp = agent.promptRuntime?.temperature ?? agent.resolvedTemperature;
    for await (const chunk of chatWithFallback(agent.chatMessages, agent.modelKey, agent.modelInfo.maxTokens || 4096, dynamicTemp, agent.decision.fallbacks)) {
      if (clientDisconnected) break; // stop consuming the provider stream
      if (chunk.type === 'chunk' && chunk.content) {
        if (!streamStarted) { streamStarted = true; timer.onStreamStart(); }
        if (!firstTokenRecorded) { firstTokenRecorded = true; timer.onFirstToken(); }
        timer.onToken();
        fullContent += chunk.content;
        if (chunk.model) usedModel = chunk.model;
        safeWrite(`data: ${JSON.stringify(chunk)}\n\n`);
      } else if (chunk.type === 'model_switch') {
        if (chunk.model) usedModel = chunk.model;
        await addEvent(traceId, 'FALLBACK', { from: agent.modelKey, to: chunk.model, reason: 'primary_model_failed' }, 'warning');
        safeWrite(`data: ${JSON.stringify({ type: 'model_switch', from: displayModel(agent.modelKey), to: displayModel(chunk.model) })}\n\n`);
      } else if (chunk.type === 'usage' && chunk.usage) {
        providerUsage = chunk.usage;
      } else if (chunk.type === 'error') {
        finishReason = 'error';
        await addError(traceId, { userId, errorType: 'model_error', message: chunk.content || 'Model error', stage: 'model', provider: agent.modelInfo.provider, model: agent.modelKey, severity: 'ERROR' });
        safeWrite(`data: ${JSON.stringify(chunk)}\n\n`);
        fullContent = chunk.content || 'Error';
        break;
      } else if (chunk.type === 'done') {
        if (chunk.model) usedModel = chunk.model;
        // 真实 token：只认 provider 回传的 chunk.tokens。
        // 原先是 `|| Math.ceil(fullContent.length / 3)` —— 用字符数除 3 估一个
        // token 数出来。这是整套假 token 显示的源头：用户看到的"已用 token"
        // 其实是把输出文本长度除了个数，与真实计费口径完全脱节。现在没有
        // provider 数据就记 0，缺口显示为 0/未知，不再编造。
        tokenCount = chunk.tokens || 0;
      }
    }

    timer.onStreamEnd();

    // 释放免费版轮询在 routeModel 中预占的速率闸门（单API/运营商/模型并行占用）
    agent.decision?.release?.();

    if (clientDisconnected) finishReason = 'interrupted';
    if (providerUsage?.total_tokens) { tokenCount = providerUsage.total_tokens; }

    // Record routing feedback for adaptive performance
    const tokensPerSec = timer.streamDurationMs && timer.tokenCount > 0
      ? timer.tokenCount / (timer.streamDurationMs / 1000) : 50;
    recordRoutingResult(usedModel, finishReason === 'stop', timer.ttftMs, tokensPerSec, undefined);

    const verification = verifyResponse(agent.taskClassification, fullContent);
    // Update performance with verification result
    if (finishReason === 'stop') {
      recordRoutingResult(usedModel, true, timer.ttftMs, tokensPerSec, verification.passed);
    }
    await addEvent(traceId, 'VALIDATION', { passed: verification.passed, score: verification.score, checks: verification.checks }, verification.passed ? 'success' : 'warning');

    updateSession(agent.session.sessionId, { status: finishReason === 'stop' ? 'completed' : 'failed', currentPhase: 'response', tokensUsed: tokenCount });

    // Bill the model that actually produced the output (fallback may switch models)
    const usedModelInfo = (getDynamicModels() as any)[usedModel] || agent.modelInfo;
    const costPer1k = usedModelInfo.costPer1k || 0;
    // 关键：provider 没回 usage 时，绝不按 70%/30% 编造输入输出拆分。
    // tokenCount 本身也只来自 providerUsage.total_tokens（见本函数上方），
    // 没有 usage 就是 0 —— 0 是诚实的，伪造的拆分不是。
    const inputTokens = providerUsage?.prompt_tokens;
    const outputTokens = providerUsage?.completion_tokens;
    const apiCost = tokenCount * costPer1k / 1000;

    await addModelCall(traceId, {
      provider: agent.modelInfo.provider, requestedModel: agent.modelKey, selectedModel: usedModel,
      startedAt: modelStart, completedAt: new Date(), durationMs: timer.totalDurationMs,
      status: finishReason === 'stop' ? 'success' : 'error',
      inputTokens, outputTokens, totalTokens: tokenCount,
      providerRawUsage: providerUsage || undefined,
      inputCostUsd: inputTokens * costPer1k / 1000,
      outputCostUsd: outputTokens * costPer1k / 1000,
      totalCostUsd: apiCost, finishReason,
    });

    await addEvent(traceId, 'MODEL', { selectedModel: usedModel, totalTokens: tokenCount, finishReason }, finishReason === 'stop' ? 'success' : 'error', timer.totalDurationMs);

    const creditsCost = tokenCount * costPer1k / 1000;
    let creditsAfter = user.creditBalance;
    if (creditsCost > 0) {
      try {
        creditsAfter = await deductCredits(userId, creditsCost, usedModel, undefined, traceId, requestId);
        await addEvent(traceId, 'BILLING', { creditsCharged: creditsCost, creditsBefore: user.creditBalance, creditsAfter }, 'success');
      } catch (err: any) {
        await addError(traceId, { userId, errorType: 'billing_error', message: err.message, stage: 'billing', severity: 'ERROR', recoverable: false });
      }
    }

    // ===== Token Billing Runtime (Actual vs Display separation) =====
    // Records the provider's ACTUAL usage (immutable, backend-only) and
    // the DISPLAY consumption (multiplier + overflow transfer) that the
    // user sees / that was charged. The legacy deductCredits above keeps
    // charging on the raw total; this layer persists the split record so
    // cost analysis reads `actual` and user-facing views read `display`.
    try {
      await processTokenUsage({
        userId,
        sessionId: agent.session?.sessionId,
        messageId: traceId,
        modelKey: usedModel,
        mode: mode || 'standard',
        providerUsage: { inputTokens, outputTokens },
        traceId,
        requestId,
      });
    } catch (err: any) {
      await addEvent(traceId, 'BILLING', { tokenUsageError: err?.message }, 'warn');
    }

    if (mode === 'think') { try { await incrementDailyUsage(userId, 'think'); } catch {} }

    await prismaConversation.message.create({
      data: { conversationId: conversation.id, role: 'assistant', content: fullContent, messageType: 'text', model: usedModel, mode: mode || 'standard', tokenCount, creditsCost,
        ...(safetyWarningForReply ? { metadata: JSON.stringify({ safetyWarning: safetyWarningForReply }) } : {}) },
    });

    await completeTrace(traceId, {
      status: finishReason === 'stop' ? 'SUCCESS' : 'PARTIAL_SUCCESS',
      selectedModel: usedModel, provider: agent.modelInfo.provider,
      totalTokens: tokenCount, inputTokens, outputTokens,
      totalApiCostUsd: apiCost, creditsCharged: creditsCost,
      creditsBefore: user.creditBalance, creditsAfter, finishReason,
      ttftMs: timer.ttftMs, streamDurationMs: timer.streamDurationMs, pricingVersion: '2026-09',
    });

    // ===== Memory Runtime: After Response (fire-and-forget) =====
    memoryRuntime.afterResponse(userId, conversation.id, message, fullContent, user.language).catch(err => {
      console.error('[Memory] afterResponse error:', err);
    });

    // 用户信息整理 AI（专项链路）：与规则式 afterResponse 并行，fire-and-forget。
    // 内部按触发规则（明确保存/纠正/偏好信号/抽样）决定是否真的调用模型；
    // 幂等键保证同一事件不重复写库；失败不影响已返回给用户的回复。
    runUserCuration({
      userId,
      conversationId: conversation.id,
      userMessage: message,
      assistantResponse: fullContent,
      // 新会话首条消息：触发判定里 messageCount=1（不参与抽样）
      messageCount: 1,
    }).catch(err => {
      console.error('[Curation] fire-and-forget error:', err?.message ?? err);
    });
    maybeGenerateConversationTitle(conversation.id, message).catch(() => {});

    // ===== M5 Outcome / M6 Attribution (fire-and-forget, scenario router only) =====
    enqueueM5OutcomeFireAndForget(userId, agent, {
      usedModel,
      fallbackUsed: usedModel !== agent.modelKey,
      verificationPassed: verification.passed,
      originalRequest: message,
      fullContent,
      promptSummary: agent.promptRuntime?.composition?.final_prompt?.slice(0, 1000),
      skillIds: agent.skillIds,
    });

    // 本次请求结束：压缩提示随本次请求一起消失（任务可能仍在后台跑，
    // 下一次请求会重新评估并按需重新提示）。不清除会让提示长期悬挂。
    if (agent.activeCompressionTaskId) {
      safeWrite(`data: ${JSON.stringify({ type: 'context_compression_done' })}\n\n`);
    }
    safeWrite(`data: ${JSON.stringify({ type: 'done', model: usedModel, tokens: tokenCount, creditsCost, conversationId: conversation.id, traceId })}\n\n`);
    safeWrite('data: [DONE]\n\n');
    if (!clientDisconnected) res.end();
    } finally {
      if (queueTicket) queueTicket.release();
    }
  } catch (err) {
    console.error('Chat error:', err);
    try {
      await addError(traceId, { errorType: 'server_error', message: err instanceof Error ? err.message : 'Unknown', stage: 'server', severity: 'ERROR', stack: err instanceof Error ? err.stack : undefined });
      await completeTrace(traceId, { status: 'FAILED' });
    } catch {}
    if (!res.headersSent) res.status(500).json({ error: '对话失败' });
    else if (!res.destroyed && !res.writableEnded) { try { res.write(`data: ${JSON.stringify({ type: 'error', content: '服务错误' })}\n\n`); res.end(); } catch {} }
  }
});

// ================================================================
// /conversations aliases — static paths must be registered before /:id
// ================================================================
router.get('/conversations', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const page = parseInt(String(req.query.page)) || 1;
    const limit = parseInt(String(req.query.limit)) || 20;
    const search = String(req.query.search || '');
    const skip = (page - 1) * limit;
    const where: any = { userId };
    if (search) where.title = { contains: search };

    const [conversations, total] = await Promise.all([
      prismaConversation.conversation.findMany({
        where, skip, take: limit,
        orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }],
        include: { _count: { select: { messages: true } } },
      }),
      prismaConversation.conversation.count({ where }),
    ]);

    res.json({ conversations, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('List conversations error:', err);
    res.status(500).json({ error: '获取对话列表失败' });
  }
});

router.post('/conversations', authMiddleware, rateLimit(60000, 30), async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { model: requestedModel, mode } = req.body || {};
  const message = req.body?.message || req.body?.content;

  if (!message) {
    try {
      const conversation = await prismaConversation.conversation.create({
        data: { userId, title: '新对话' },
      });
      return res.json({ conversation });
    } catch {
      return res.status(500).json({ error: '创建对话失败' });
    }
  }

  // Delegate to POST / handler for full chat logic
  req.body.message = message;
  req.url = '/';
  req.method = 'POST';
  return (router as any).handle(req, res, (err: any) => {
    res.status(500).json({ error: err?.message || '对话失败' });
  });
});

router.get('/conversations/:id/messages', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversation = await prismaConversation.conversation.findUnique({
      where: { id: String(req.params.id) },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation || conversation.userId !== req.user!.id) return res.status(404).json({ error: '对话不存在' });
    res.json({ messages: conversation.messages, conversation });
  } catch { res.status(500).json({ error: '获取对话失败' }); }
});

router.post('/conversations/:id/messages', authMiddleware, rateLimit(60000, 30), async (req: AuthRequest, res: Response) => {
  if (req.body?.content && !req.body.message) req.body.message = req.body.content;
  req.url = `/${req.params.id}/messages`;
  req.params.id = String(req.params.id);
  return (router as any).handle(req, res, (err: any) => {
    res.status(500).json({ error: err?.message || '消息发送失败' });
  });
});

router.delete('/conversations/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversation = await prismaConversation.conversation.findUnique({ where: { id: String(req.params.id) } });
    if (!conversation || conversation.userId !== req.user!.id) return res.status(404).json({ error: '对话不存在' });
    await prismaConversation.conversation.delete({ where: { id: String(req.params.id) } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '删除失败' }); }
});

router.patch('/conversations/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversation = await prismaConversation.conversation.findUnique({ where: { id: String(req.params.id) } });
    if (!conversation || conversation.userId !== req.user!.id) return res.status(404).json({ error: '对话不存在' });
    const isPinned = typeof req.body?.isPinned === 'boolean' ? req.body.isPinned : !conversation.isPinned;
    const updated = await prismaConversation.conversation.update({ where: { id: String(req.params.id) }, data: { isPinned } });
    res.json({ conversation: updated });
  } catch { res.status(500).json({ error: '操作失败' }); }
});

router.post('/conversations/:id/retry', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversation = await prismaConversation.conversation.findUnique({
      where: { id: String(req.params.id) },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 2 } },
    });
    if (!conversation || conversation.userId !== req.user!.id) return res.status(404).json({ error: '对话不存在' });
    const lastUser = conversation.messages.find((m: any) => m.role === 'user');
    if (!lastUser) return res.status(400).json({ error: '没有可重试的消息' });
    req.body = { ...(req.body || {}), message: lastUser.content };
    req.url = `/${conversation.id}/messages`;
    req.params.id = conversation.id;
    return (router as any).handle(req, res, (err: any) => {
      res.status(500).json({ error: err?.message || '重试失败' });
    });
  } catch { res.status(500).json({ error: '重试失败' }); }
});

router.post('/deep-research', authMiddleware, async (req: AuthRequest, res: Response) => {
  req.body = { ...(req.body || {}), message: req.body?.topic || req.body?.message, mode: 'research' };
  if (req.body.conversationId) {
    req.url = `/${req.body.conversationId}/messages`;
    req.params.id = req.body.conversationId;
  } else {
    req.url = '/';
  }
  return (router as any).handle(req, res, (err: any) => {
    res.status(500).json({ error: err?.message || '研究失败' });
  });
});

// ================================================================
// GET /:id — get conversation with messages
// ================================================================
// ================================================================
// GET /usage — chat usage summary for current user
// 注意：必须注册在 /:id 之前，否则会被影子路由当作会话 ID 吞掉。
// ================================================================
router.get('/usage', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const creditBalance = user?.creditBalance ?? 0;

    const since7d = new Date();
    since7d.setDate(since7d.getDate() - 7);
    const messages7d = await prismaConversation.message.count({
      where: { conversation: { userId }, createdAt: { gte: since7d } },
    });

    res.json({
      creditBalance,
      usage: { messages7d },
    });
  } catch (err) {
    console.error('Usage error:', err);
    res.status(500).json({ error: '获取用量失败' });
  }
});

router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversation = await prismaConversation.conversation.findUnique({
      where: { id: String(req.params.id) },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation || conversation.userId !== req.user!.id) return res.status(404).json({ error: '对话不存在' });
    res.json({ conversation });
  } catch { res.status(500).json({ error: '获取对话失败' }); }
});

// ================================================================
// POST /:id/messages — send message in existing conversation (SSE)
// ================================================================
router.post('/:id/messages', authMiddleware, rateLimit(60000, 30), async (req: AuthRequest, res: Response) => {
  const traceId = newTraceId();
  const requestId = newRequestId();
  const timer = new StreamTimer();

  try {
    const userId = req.user!.id;
    const conversationId = String(req.params.id);
    const { model: requestedModel, mode } = req.body;
    const message = req.body.message || req.body.content;
    if (!message) return res.status(400).json({ error: '请输入消息' });

    const conversation = await prismaConversation.conversation.findUnique({
      where: { id: conversationId },
      include: { messages: { orderBy: { createdAt: 'asc' }, take: 50 } },
    });
    if (!conversation || conversation.userId !== userId) return res.status(404).json({ error: '对话不存在' });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: '用户不存在' });

    // ===== Safety Gate — 敏感拦截，先于媒体/文档/研究分发 =====
    // 高敏感直拒 + 落档；中敏感同一受限事项 1~3 次警告正常作答，第 4 次起拒绝并落档。
    // 次数由 registerTopicOccurrence 按“同一受限事项”在会话内原子累计
    // （无关话题不继承计数，也不依赖内存计数器）。
    let safetyWarningForReply = 0;
    let safetyTopicsForReply: string[] = [];
    const safetyVerdict = evaluateSensitivity(message);
    if (safetyVerdict.level !== 'none') {
      const occurrence = await registerTopicOccurrence(conversation.id, safetyVerdict.labels);
      if (safetyVerdict.level === 'high' || occurrence > MAX_MEDIUM_WARNINGS) {
        const sourceMessageId = req.body.messageId || req.body.clientMessageId || null;
        const refuse = await issueSafetyRefusal({
          userId, username: user.username, conversation, message,
          level: safetyVerdict.level === 'high' ? 'high' : 'medium',
          labels: safetyVerdict.labels, warningCount: occurrence, model: requestedModel,
          sourceMessageId,
        });
        return res.json({ type: 'safety_refusal', conversation: { id: conversation.id }, refusalMessage: refuse.refusalMessage });
      }
      safetyWarningForReply = occurrence;
    }

    // ===== Media Intent (Gemini) — run before any other processing =====
    // 若用户想生成图片/视频，则走确认卡片流程；否则正常聊天
    const contextForIntent = conversation.messages
      .slice(-5)
      .filter((m: any) => m.messageType !== 'media_confirm')
      .map((m: any) => `${m.role}: ${m.content}`).join('\n');
    const mediaIntent = await analyzeMediaIntent(message, contextForIntent);
    if (mediaIntent.intent === 'image-gen' || mediaIntent.intent === 'video-gen') {
      const p = mediaIntent.params;
      const meta = {
        kind: mediaIntent.intent,
        status: 'pending',
        prompt: mediaIntent.prompt,
        params: {
          model: p.model || (mediaIntent.intent === 'image-gen' ? 'agnes-image-2.5-flash' : 'agnes-video-2.5-flash'),
          ratio: p.ratio,
          resolution: p.resolution,
          seconds: p.seconds,
        },
      };
      const userMsg = await prismaConversation.message.create({
        data: { conversationId, role: 'user', content: message, messageType: 'text' },
      });
      const confirmMsg = await prismaConversation.message.create({
        data: {
          conversationId, role: 'assistant',
          content: mediaIntent.prompt,
          messageType: 'media_confirm',
          metadata: JSON.stringify(meta),
        },
      });
      res.json({
        type: 'media_confirm',
        confirmMessage: { id: confirmMsg.id, messageType: 'media_confirm', content: mediaIntent.prompt, metadata: meta, createdAt: confirmMsg.createdAt },
        userMessageId: userMsg.id,
      });
      return;
    }

    // ===== Audio Generation Intent (existing conversation) =====
    // "用刚才那个声音再读一遍" / "帮我生成一个纪录片男声" → open the
    // audio spec card with auto-filled fields + Context Reference.
    const audioGate = analyzeAudioGenerationIntent({
      message,
      history: conversation.messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content, messageId: m.id })),
    });
    if (audioGate.shouldOpenAudioCard) {
      const defaultAudioModel = TTS_MODELS[0].modelId;
      const audioMeta = {
        kind: 'audio-gen',
        status: 'pending',
        prompt: audioGate.autoFill?.spokenText || audioGate.autoFill?.contentOverview || message,
        params: {
          model: defaultAudioModel,
          format: TTS_MODELS[0].defaultFormat,
          voiceDesign: audioGate.autoFill?.voiceDesign || undefined,
          contentOverview: audioGate.autoFill?.contentOverview || audioGate.autoFill?.spokenText,
          spokenText: audioGate.autoFill?.spokenText || undefined,
          styleInstruction: audioGate.autoFill?.styleInstruction || undefined,
          voiceReferenceHint: audioGate.autoFill?.voiceReferenceHint || false,
        },
      };
      const userMsg = await prismaConversation.message.create({
        data: { conversationId, role: 'user', content: message, messageType: 'text' },
      });
      const audioConfirmMsg = await prismaConversation.message.create({
        data: {
          conversationId, role: 'assistant',
          content: audioMeta.prompt,
          messageType: 'media_confirm',
          metadata: JSON.stringify(audioMeta),
        },
      });
      res.json({
        type: 'media_confirm',
        confirmMessage: { id: audioConfirmMsg.id, messageType: 'media_confirm', content: audioMeta.prompt, metadata: audioMeta, createdAt: audioConfirmMsg.createdAt },
        userMessageId: userMsg.id,
      });
      return;
    }

    // ===== Office / Document Generation Intent (existing conversation) =====
    // "第四页内容少一点" / "刚才那个转成 PDF" / "改成 15 页" → open the
    // office spec card with the target reference + context preserved.
    const officeGate = analyzeOfficeGenerationIntent({
      message,
      history: conversation.messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content, messageId: m.id })),
    });
    if (officeGate.shouldOpenCard && officeGate.kind) {
      const af = officeGate.autoFill ?? {};
      // 引用既有文件时解析成真实 artifact id（限本用户、优先同会话）
      const sourceArtifactId = af.sourceArtifactHint
        ? await resolveOfficeArtifactId(userId, conversationId, af.targetRef)
        : undefined;
      const officeMeta = {
        kind: 'office-gen',
        status: 'pending',
        prompt: af.contentOverview || message,
        params: {
          artifactType: af.artifactType || officeGate.kind,
          format: af.format || defaultFormatFor(af.artifactType || officeGate.kind),
          contentOverview: af.contentOverview,
          title: af.title || undefined,
          audience: af.audience || undefined,
          pageOrSlideCount: af.pageOrSlideCount,
          documentType: af.documentType || undefined,
          style: af.style || undefined,
          sourceArtifactId,
          operation: af.operation || 'generate',
          targetRef: af.targetRef || undefined,
        },
      };
      const userMsg = await prismaConversation.message.create({
        data: { conversationId, role: 'user', content: message, messageType: 'text' },
      });
      const officeConfirmMsg = await prismaConversation.message.create({
        data: {
          conversationId, role: 'assistant',
          content: officeMeta.prompt,
          messageType: 'media_confirm',
          metadata: JSON.stringify(officeMeta),
        },
      });
      res.json({
        type: 'media_confirm',
        confirmMessage: { id: officeConfirmMsg.id, messageType: 'media_confirm', content: officeMeta.prompt, metadata: officeMeta, createdAt: officeConfirmMsg.createdAt },
        userMessageId: userMsg.id,
      });
      return;
    }

    if (mode === 'think') {
      const limit = await checkDailyLimit(userId, 'think');
      if (!limit.allowed) {
        await createTrace({ traceId, requestId, userId, conversationId, requestedModel, mode, region: user.region });
        await addError(traceId, { userId, errorType: 'rate_limit', message: '今日深度思考次数已用完', stage: 'auth', severity: 'WARN' });
        await completeTrace(traceId, { status: 'RATE_LIMITED' });
        return res.status(429).json({ error: '今日深度思考次数已用完' });
      }
    }

    await createTrace({ traceId, requestId, userId, conversationId, requestedModel, mode, region: user.region });
    await addEvent(traceId, 'REQUEST', { requestedModel, mode, message: message.substring(0, 200), conversationId });

    const historyMessages = conversation.messages.map((m: any) => ({ role: m.role, content: m.content }));

    // Agent Runtime + Memory Runtime
    // SSE 预连接（先建响应再跑预处理，首字节即时）
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'accepted' })}\n\n`);
    // ===== 上下文压缩状态（对话感知）=====
    // 任务书要求"聊天时正在发生历史压缩"必须可感知、可理解，且前端文案固定。
    // 这里只做状态推送：压缩本身已在 buildModelContext 里异步排队，
    // 不阻塞、不中断本次回复（"当前已经成功提交的模型推理不应因后台压缩被
    // 无故中断"）。
    const agent = await buildAgentChat(userId, user, message, mode, requestedModel, historyMessages, traceId, conversationId);

    // 机制 A（存储压缩）触发判断：消息数达到阈值时排队，与上下文压缩互不阻塞。
    // 同一对话同时只允许一个活动任务，冲突时 enqueueIfIdle 返回 null。
    void (async () => {
      try {
        const d = await evaluateStorageCompression(conversationId);
        if (d.shouldCompress && d.compressStartSeq && d.compressEndSeq) {
          const { enqueueIfIdle } = await import('../services/memoryManager');
          await enqueueIfIdle(conversationId, userId, 'storage', d.compressStartSeq, d.compressEndSeq, agent.modelKey);
        }
      } catch (err: any) {
        console.warn('[Chat] storage compression trigger failed:', err?.message);
      }
    })();

    if (!agent.modelInfo) {
      await addError(traceId, { userId, errorType: 'validation', message: `无效模型: ${agent.modelKey}`, stage: 'router', severity: 'WARN' });
      await completeTrace(traceId, { status: 'FAILED' });
      return res.status(400).json({ error: '无效模型' });
    }

    const userMsgRow = await prismaConversation.message.create({ data: { conversationId, role: 'user', content: message, messageType: 'text' } });

    // ===== Context Memory: persist high-value signals (P1/P2/P3) + dispatch
    // a verification trigger for factual corrections. Fire-and-forget so the
    // response path is never blocked. Idempotent via dedupeKey. =====
    void (async () => {
      try {
        const tier = user.subscriptionTier || 'FREE';
        const writeRes = await writeMemory({
          userId,
          conversationId,
          messageId: userMsgRow.id,
          message,
          recentHistory: historyMessages.slice(-10).map((h) => ({ role: h.role, content: h.content })),
          tier,
          scenarioId: agent.scenarioRoutingId ?? null,
        });
        if (writeRes) {
          const trigger = await evaluateCompressionTrigger(userId, conversationId, tier, {
            justCorrected: !!writeRes.correctionEventId,
            taskStageChanged: writeRes.activeTaskUpdated,
          });
          if (trigger.shouldCompress && trigger.trigger) {
            void enqueueCompression(userId, conversationId, tier, trigger.trigger).catch(() => undefined);
          }
        }
      } catch (err: any) {
        console.warn('[Chat] context memory write failed:', err?.message);
      }
    })();

    // ===== Client disconnect handling =====
    let clientDisconnected = false;
    req.on('close', () => {
      if (!res.writableEnded) clientDisconnected = true;
    });
    const safeWrite = (payload: string): void => {
      if (clientDisconnected || res.destroyed || res.writableEnded) return;
      try { res.write(payload); } catch { clientDisconnected = true; };
    };

    // ===== 上下文压缩状态（对话感知）=====
    // 任务书要求"聊天时正在发生历史压缩"必须可感知、可理解，且文案固定。
    // 只做状态推送：压缩已在 buildModelContext 内异步排队，不阻塞、
    // 不中断本次回复（已成功提交的模型推理不应因后台压缩被无故中断）。
    if (agent.activeCompressionTaskId) {
      safeWrite(`data: ${JSON.stringify({
        type: 'context_compression',
        status: 'compressing',
        text: COMPRESSION_STATUS_TEXT,
        taskId: agent.activeCompressionTaskId,
      })}\n\n`);
    }

    // ===== High Server Load / Frequency Queue Slot Acquisition =====
    let queueTicket: any = null;
    try {
      queueTicket = await chatQueue.acquireSlot({
        userId,
        requestId,
        onQueueUpdate: (info) => {
          safeWrite(`data: ${JSON.stringify({ type: 'queue', status: 'queued', ...info })}\n\n`);
        },
      });
      safeWrite(`data: ${JSON.stringify({ type: 'queue', status: 'processing' })}\n\n`);
    } catch (queueErr: any) {
      safeWrite(`data: ${JSON.stringify({ type: 'error', content: queueErr?.message || '服务器繁忙，排队失败' })}\n\n`);
      if (!clientDisconnected) res.end();
      return;
    }

    // 速率闸门（供应商/API/模型额度）：本次请求已预排队或阻断 → 告知前端
    const qd = agent.decision as any;
    if (qd?.queueBlocked) {
      safeWrite(`data: ${JSON.stringify({ type: 'model_throttled', status: 'blocked', model: agent.modelKey })}\n\n`);
    } else if (qd?.queueTimedOut) {
      safeWrite(`data: ${JSON.stringify({ type: 'model_throttled', status: 'timed_out', model: agent.modelKey })}\n\n`);
    } else if (qd?.queuedMs) {
      safeWrite(`data: ${JSON.stringify({ type: 'model_queued', ms: qd.queuedMs, model: agent.modelKey })}\n\n`);
    }

    try {
    let fullContent = '';
    let tokenCount = 0;
    let usedModel = agent.modelKey;
    let modelStart = new Date();
    let streamStarted = false;
    let firstTokenRecorded = false;
    let finishReason = 'stop';
    let providerUsage: any = null;

    await addEvent(traceId, 'MODEL', { provider: agent.modelInfo.provider, requestedModel: agent.modelKey, apiModel: agent.modelInfo.apiModel }, 'started');

    const dynamicTemp2 = agent.promptRuntime?.temperature ?? agent.resolvedTemperature;
    for await (const chunk of chatWithFallback(agent.chatMessages, agent.modelKey, agent.modelInfo.maxTokens || 4096, dynamicTemp2, agent.decision.fallbacks)) {
      if (clientDisconnected) break;
      if (chunk.type === 'chunk' && chunk.content) {
        if (!streamStarted) { streamStarted = true; timer.onStreamStart(); }
        if (!firstTokenRecorded) { firstTokenRecorded = true; timer.onFirstToken(); }
        timer.onToken();
        fullContent += chunk.content;
        if (chunk.model) usedModel = chunk.model;
        safeWrite(`data: ${JSON.stringify(chunk)}\n\n`);
      } else if (chunk.type === 'model_switch') {
        if (chunk.model) usedModel = chunk.model;
        recordRoutingFallback(agent.modelKey, chunk.model);
        await addEvent(traceId, 'FALLBACK', { from: agent.modelKey, to: chunk.model, reason: 'primary_model_failed' }, 'warning');
        safeWrite(`data: ${JSON.stringify({ type: 'model_switch', from: displayModel(agent.modelKey), to: displayModel(chunk.model) })}\n\n`);
      } else if (chunk.type === 'usage' && chunk.usage) {
        providerUsage = chunk.usage;
      } else if (chunk.type === 'error') {
        // Determine error type for proper recording
        if (chunk.content?.includes('429') || chunk.content?.includes('rate')) {
          recordRoutingRateLimit(usedModel);
        } else if (chunk.content?.includes('timeout') || chunk.content?.includes('ETIMEDOUT')) {
          recordRoutingTimeout(usedModel);
        } else {
          recordRoutingResult(usedModel, false);
        }
        finishReason = 'error';
        await addError(traceId, { userId, errorType: 'model_error', message: chunk.content || 'Model error', stage: 'model', provider: agent.modelInfo.provider, model: agent.modelKey, severity: 'ERROR' });
        safeWrite(`data: ${JSON.stringify(chunk)}\n\n`);
        fullContent = chunk.content || 'Error';
        break;
      } else if (chunk.type === 'done') {
        if (chunk.model) usedModel = chunk.model;
        // 真实 token：只认 provider 回传的 chunk.tokens。
        // 原先是 `|| Math.ceil(fullContent.length / 3)` —— 用字符数除 3 估一个
        // token 数出来。这是整套假 token 显示的源头：用户看到的"已用 token"
        // 其实是把输出文本长度除了个数，与真实计费口径完全脱节。现在没有
        // provider 数据就记 0，缺口显示为 0/未知，不再编造。
        tokenCount = chunk.tokens || 0;
      }
    }

    timer.onStreamEnd();

    // 释放免费版轮询在 routeModel 中预占的速率闸门（单API/运营商/模型并行占用）
    agent.decision?.release?.();

    if (clientDisconnected) finishReason = 'interrupted';
    if (providerUsage?.total_tokens) { tokenCount = providerUsage.total_tokens; }

    // Record routing feedback for adaptive performance
    const tokensPerSec = timer.streamDurationMs && timer.tokenCount > 0
      ? timer.tokenCount / (timer.streamDurationMs / 1000) : 50;
    recordRoutingResult(usedModel, finishReason === 'stop', timer.ttftMs, tokensPerSec, undefined);

    const verification = verifyResponse(agent.taskClassification, fullContent);
    // Update performance with verification result
    if (finishReason === 'stop') {
      recordRoutingResult(usedModel, true, timer.ttftMs, tokensPerSec, verification.passed);
    }
    await addEvent(traceId, 'VALIDATION', { passed: verification.passed, score: verification.score, checks: verification.checks }, verification.passed ? 'success' : 'warning');

    updateSession(agent.session.sessionId, { status: finishReason === 'stop' ? 'completed' : 'failed', tokensUsed: tokenCount });

    // 关键：provider 没回 usage 时，绝不按 70%/30% 编造输入输出拆分。
    // tokenCount 本身也只来自 providerUsage.total_tokens（见本函数上方），
    // 没有 usage 就是 0 —— 0 是诚实的，伪造的拆分不是。
    const inputTokens = providerUsage?.prompt_tokens;
    const outputTokens = providerUsage?.completion_tokens;
    const usedModelInfo2 = (getDynamicModels() as any)[usedModel] || agent.modelInfo;
    const costPer1k2 = usedModelInfo2.costPer1k || 0;
    const apiCost = tokenCount * costPer1k2 / 1000;

    await addModelCall(traceId, {
      provider: agent.modelInfo.provider, requestedModel: agent.modelKey, selectedModel: usedModel,
      startedAt: modelStart, completedAt: new Date(), durationMs: timer.totalDurationMs,
      status: finishReason === 'stop' ? 'success' : 'error',
      inputTokens, outputTokens, totalTokens: tokenCount,
      providerRawUsage: providerUsage || undefined,
      inputCostUsd: inputTokens * costPer1k2 / 1000,
      outputCostUsd: outputTokens * costPer1k2 / 1000,
      totalCostUsd: apiCost, finishReason,
    });

    const creditsCost = tokenCount * costPer1k2 / 1000;
    let creditsAfter = user.creditBalance;
    if (creditsCost > 0) {
      try {
        creditsAfter = await deductCredits(userId, creditsCost, usedModel, undefined, traceId, requestId);
        await addEvent(traceId, 'BILLING', { creditsCharged: creditsCost, creditsBefore: user.creditBalance, creditsAfter }, 'success');
      } catch (err: any) {
        await addError(traceId, { userId, errorType: 'billing_error', message: err.message, stage: 'billing', severity: 'ERROR' });
      }
    }

    // ===== Token Billing Runtime (Actual vs Display separation) =====
    try {
      await processTokenUsage({
        userId,
        sessionId: agent.session?.sessionId,
        messageId: traceId,
        modelKey: usedModel,
        mode: mode || 'standard',
        providerUsage: { inputTokens, outputTokens },
        traceId,
        requestId,
      });
    } catch (err: any) {
      await addEvent(traceId, 'BILLING', { tokenUsageError: err?.message }, 'warn');
    }

    if (mode === 'think') { try { await incrementDailyUsage(userId, 'think'); } catch {} }

    await prismaConversation.message.create({
      data: { conversationId, role: 'assistant', content: fullContent, messageType: 'text', model: usedModel, mode: mode || 'standard', tokenCount, creditsCost,
        ...(safetyWarningForReply ? { metadata: JSON.stringify({ safetyWarning: safetyWarningForReply }) } : {}) },
    });

    await completeTrace(traceId, {
      status: finishReason === 'stop' ? 'SUCCESS' : 'PARTIAL_SUCCESS',
      selectedModel: usedModel, provider: agent.modelInfo.provider,
      totalTokens: tokenCount, inputTokens, outputTokens,
      totalApiCostUsd: apiCost, creditsCharged: creditsCost,
      creditsBefore: user.creditBalance, creditsAfter, finishReason,
      ttftMs: timer.ttftMs, streamDurationMs: timer.streamDurationMs, pricingVersion: '2026-09',
    });

    // ===== Memory Runtime: After Response (fire-and-forget) =====
    memoryRuntime.afterResponse(userId, conversationId, message, fullContent, user.language).catch(err => {
      console.error('[Memory] afterResponse error:', err);
    });

    // 用户信息整理 AI：传入最近消息供多轮上下文判断；失败不阻塞主回复
    runUserCuration({
      userId,
      conversationId,
      userMessage: message,
      assistantResponse: fullContent,
      recentMessages: (conversation.messages || []).slice(-4).map((m: any) => ({ role: m.role, content: m.content })),
      messageCount: conversation.messages?.length ?? 1,
    }).catch(err => {
      console.error('[Curation] fire-and-forget error:', err?.message ?? err);
    });
    maybeGenerateConversationTitle(conversationId, message).catch(() => {});

    // ===== M5 Outcome / M6 Attribution (fire-and-forget, scenario router only) =====
    enqueueM5OutcomeFireAndForget(userId, agent, {
      usedModel,
      fallbackUsed: usedModel !== agent.modelKey,
      verificationPassed: verification.passed,
      originalRequest: message,
      fullContent,
      promptSummary: agent.promptRuntime?.composition?.final_prompt?.slice(0, 1000),
      skillIds: agent.skillIds,
    });

    safeWrite(`data: ${JSON.stringify({ type: 'done', model: usedModel, tokens: tokenCount, creditsCost, traceId })}\n\n`);
    safeWrite('data: [DONE]\n\n');
    if (!clientDisconnected) res.end();
    } finally {
      if (queueTicket) queueTicket.release();
    }
  } catch (err) {
    console.error('Chat message error:', err);
    try {
      await addError(traceId, { errorType: 'server_error', message: err instanceof Error ? err.message : 'Unknown', stage: 'server', severity: 'ERROR', stack: err instanceof Error ? err.stack : undefined });
      await completeTrace(traceId, { status: 'FAILED' });
    } catch {}
    if (!res.headersSent) res.status(500).json({ error: '发送失败' });
    else if (!res.destroyed && !res.writableEnded) { try { res.write(`data: ${JSON.stringify({ type: 'error', content: '服务错误' })}\n\n`); res.end(); } catch {} }
  }
});
// ================================================================
// DELETE /:id
// ================================================================
router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversation = await prismaConversation.conversation.findUnique({ where: { id: String(req.params.id) } });
    if (!conversation || conversation.userId !== req.user!.id) return res.status(404).json({ error: '对话不存在' });
    await prismaConversation.conversation.delete({ where: { id: String(req.params.id) } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '删除失败' }); }
});

// ================================================================
// PATCH /:id/pin
// ================================================================
router.patch('/:id/pin', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const conversation = await prismaConversation.conversation.findUnique({ where: { id: String(req.params.id) } });
    if (!conversation || conversation.userId !== req.user!.id) return res.status(404).json({ error: '对话不存在' });
    const updated = await prismaConversation.conversation.update({ where: { id: String(req.params.id) }, data: { isPinned: !conversation.isPinned } });
    res.json({ conversation: updated });
  } catch { res.status(500).json({ error: '操作失败' }); }
});

export default router;
