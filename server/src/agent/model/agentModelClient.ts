// Agent Model Adapter — 将 cortex 现有 chatWithFallback 包装为 OmniTask-Agent 的 ModelClient
// 约束：
// - cortex 的 chatWithFallback 是 async generator（流式），不支持原生 tool calling
// - Agent 端期望 ModelClient.chat() 返回完整 ChatResult / chatStream() 返回 AsyncIterable<ChatDelta>
// - 工具调用采用文本 Action 协议（SWE-agent 式 ```action\n{...}\n```）
// - Usage 四分类：provider/derived/estimated/unavailable（缺失不填零）

import { chatWithFallback } from '../../services/models';
import { getDynamicModels, type ModelRegistryEntry } from '../../services/configSync';
import { getModelCapability } from '../../services/modelCapabilityRegistry';

// 契约类型：整体复制自 OmniTask-Agent src/model/types.ts（不重新定义，避免双份漂移）
import type {
  ModelTier, ModelRole, ModelRef,
  UsageSource, UsagePrecision, UsageBlock, ModelCapability, ModelErrorKind,
  ToolSpecRef, ChatRequest, ModelMessage, ToolCallRequest, Degradation,
  ChatResult, ChatDelta, ModelClient,
} from './types';
// Action 协议解析：直接复用 agent 侧实现（runbook §3-2：不得改协议形态，也不得复制第二份）
import { parseActionProtocol } from './protocol';

// --- Type adapters: cortex -> agent ---

function mapTier(tier: string): ModelTier {
  switch (tier) {
    case 'FREE':
    case 'STANDARD':
      return 'light';
    case 'PRO':
      return 'standard';
    case 'ULTRA':
      return 'strong';
    default:
      return 'standard';
  }
}

function mapMessages(messages: ModelMessage[]): any[] {
  return messages.map(m => ({
    role: m.role,
    content: m.content,
    name: m.name,
    tool_call_id: m.toolCallId,
  }));
}

// --- Usage conversion ---

function toUsageBlock(usage: any, source: UsageSource = 'provider'): UsageBlock {
  if (!usage) {
    return {
      source: 'unavailable',
      precision: 'estimate',
    };
  }

  const input = usage.prompt_tokens ?? usage.input_tokens ?? usage.input;
  const output = usage.completion_tokens ?? usage.output_tokens ?? usage.output;
  const cacheRead = usage.cache_read_input_tokens ?? usage.cacheRead;
  const cacheWrite = usage.cache_write_output_tokens ?? usage.cacheWrite;
  const reasoning = usage.reasoning_tokens ?? usage.reasoning;

  const block: UsageBlock = {
    source,
    precision: source === 'provider' ? 'exact' : source === 'derived' ? 'derived' : 'estimate',
  };

  if (typeof input === 'number') block.input = input;
  if (typeof output === 'number') block.output = output;
  if (typeof cacheRead === 'number') block.cacheRead = cacheRead;
  if (typeof cacheWrite === 'number') block.cacheWrite = cacheWrite;
  if (typeof reasoning === 'number') block.reasoning = reasoning;
  if (usage) block.raw = usage;

  return block;
}

// --- Capability conversion ---

function toModelCapability(entry: ModelRegistryEntry, cap: Awaited<ReturnType<typeof getModelCapability>>, modelKey: string): ModelCapability {
  const thinkingModes = entry.supportsReasoning ? ['reasoning'] : [];

  return {
    modelKey,
    provider: entry.provider,
    tier: mapTier(entry.tier),
    contextWindow: entry.contextWindow ?? cap.maxContextTokens ?? 32768,
    maxOutputTokens: entry.maxTokens ?? cap.maxOutputTokens ?? 8192,
    streaming: entry.supportsStreaming ?? cap.supportsStreaming ?? true,
    toolCalling: 'prompt_protocol',
    usageFields: ['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'other'],
    thinkingModes,
    supportsFallback: true,
    evidence: 'host_registry',
    observedAt: new Date().toISOString(),
  };
}

// --- Build system prompt with tool specs ---

function buildSystemPrompt(basePrompt: string, tools?: ToolSpecRef[]): string {
  if (!tools || tools.length === 0) return basePrompt;

  const toolDescs = tools.map(t =>
    `- ${t.name}: ${t.description}\n  输入 schema: ${JSON.stringify(t.inputSchema)}`
  ).join('\n');

  return `${basePrompt}

可用工具（通过 Action 协议调用，格式见下）：
${toolDescs}

调用工具时，必须在回复中包含以下代码块（可多个）：
\`\`\`action
{"name": "工具名", "args": {...}, "id": "可选调用ID"}
\`\`\`

工具执行结果将以 tool 角色消息返回，请据此继续。`;
}

// --- Adapter implementation ---

/** 获取可用的回退模型列表（同 tier 内其他模型） */
function getFallbackModels(modelKey: string): string[] {
  const models = getDynamicModels();
  const target = models[modelKey];
  if (!target) return [];

  const fallbacks = Object.entries(models)
    .filter(([k, v]) => k !== modelKey && v.tier === target.tier && v.status === 'online' && v.enabled)
    .map(([k]) => k);

  return fallbacks.slice(0, 2);
}

/** 执行流式调用并聚合完整结果 */
async function executeStream(
  messages: any[],
  modelKey: string,
  maxTokens: number,
  temperature: number,
  fallbacks: string[],
  onChunk?: (delta: ChatDelta) => void
): Promise<{ fullText: string; toolCalls: ToolCallRequest[]; usage: UsageBlock; usedModel: string; finishReason: ChatResult['finishReason']; latencyMs: number; degraded: Degradation[] }> {
  const start = Date.now();
  let fullText = '';
  let toolCalls: ToolCallRequest[] = [];
  let usage: UsageBlock = { source: 'unavailable', precision: 'estimate' };
  let usedModel = modelKey;
  let finishReason: ChatResult['finishReason'] = 'stop';
  const degraded: Degradation[] = [];

  for await (const chunk of chatWithFallback(messages, modelKey, maxTokens, temperature, fallbacks)) {
    if (chunk.type === 'chunk' && chunk.content) {
      fullText += chunk.content;
      onChunk?.({ text: chunk.content });
    } else if (chunk.type === 'model_switch') {
      usedModel = chunk.model || usedModel;
      degraded.push({ kind: 'aborted_partial', detail: `Switched to fallback model ${chunk.model}` });
    } else if (chunk.type === 'usage' && chunk.usage) {
      usage = toUsageBlock(chunk.usage, 'provider');
    } else if (chunk.type === 'error') {
      finishReason = 'error';
      degraded.push({ kind: 'aborted_partial', detail: chunk.content || 'Model error' });
    } else if (chunk.type === 'done') {
      if (chunk.model) usedModel = chunk.model;
      finishReason = 'stop';
    }
  }

  if (fullText) {
    const parsed = parseActionProtocol(fullText);
    toolCalls = parsed.calls;
    if (parsed.errors.length > 0) {
      degraded.push({ kind: 'aborted_partial', detail: `Action parse errors: ${parsed.errors.join('; ')}` });
    }
  }

  return {
    fullText,
    toolCalls,
    usage,
    usedModel,
    finishReason,
    latencyMs: Date.now() - start,
    degraded,
  };
}

export const cortexModelClient: ModelClient = {
  simulated: false,

  async chat(req: ChatRequest): Promise<ChatResult> {
    const { role, modelRef, systemPrompt, messages, tools, maxOutputTokens, temperature, metadata } = req;

    const models = getDynamicModels();
    const entry = models[modelRef.modelKey];
    if (!entry) {
      throw new Error(`Model ${modelRef.modelKey} not found in registry`);
    }

    const capability = await getModelCapability(modelRef.modelKey);
    const agentCapability = toModelCapability(entry, capability, modelRef.modelKey);
    const fallbacks = getFallbackModels(modelRef.modelKey);

    const sysPrompt = buildSystemPrompt(systemPrompt, tools);

    const { fullText, toolCalls, usage, usedModel, finishReason, latencyMs, degraded } = await executeStream(
      mapMessages(messages),
      modelRef.modelKey,
      maxOutputTokens ?? entry.maxTokens ?? 4096,
      temperature ?? 0.7,
      fallbacks,
    );

    let finalUsage = usage;
    if (usage.source === 'unavailable') {
      finalUsage = {
        ...usage,
        source: 'estimated',
        precision: 'estimate',
        estimator: 'char-based-fallback',
        input: Math.ceil(sysPrompt.length / 4) + Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4),
        output: Math.ceil(fullText.length / 4),
      };
    }

    return {
      text: fullText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: finalUsage,
      capabilitySnapshot: agentCapability,
      modelRef: { tier: agentCapability.tier, modelKey: usedModel },
      finishReason,
      latencyMs,
      degraded: degraded.length > 0 ? degraded : undefined,
      errorKind: finishReason === 'error' ? 'unknown' : undefined,
    };
  },

  async *chatStream(req: ChatRequest): AsyncIterable<ChatDelta> {
    const { role, modelRef, systemPrompt, messages, tools, maxOutputTokens, temperature, metadata } = req;

    const models = getDynamicModels();
    const entry = models[modelRef.modelKey];
    if (!entry) {
      throw new Error(`Model ${modelRef.modelKey} not found in registry`);
    }

    const fallbacks = getFallbackModels(modelRef.modelKey);
    const sysPrompt = buildSystemPrompt(systemPrompt, tools);

    let fullText = '';
    let hasStreamed = false;

    for await (const chunk of chatWithFallback(
      mapMessages(messages),
      modelRef.modelKey,
      maxOutputTokens ?? entry.maxTokens ?? 4096,
      temperature ?? 0.7,
      fallbacks,
    )) {
      if (chunk.type === 'chunk' && chunk.content) {
        fullText += chunk.content;
        hasStreamed = true;
        yield { text: chunk.content };
      } else if (chunk.type === 'model_switch') {
        yield { text: `[模型切换至 ${chunk.model}]` };
      } else if (chunk.type === 'usage' && chunk.usage) {
        yield { usage: toUsageBlock(chunk.usage, 'provider') };
      } else if (chunk.type === 'error') {
        yield { text: chunk.content || 'Error' };
      } else if (chunk.type === 'done') {
        if (fullText) {
          const parsed = parseActionProtocol(fullText);
          if (parsed.calls.length > 0) {
            yield { toolCalls: parsed.calls };
          }
        }
      }
    }
  },

  describe(ref: ModelRef): ModelCapability {
    const models = getDynamicModels();
    const entry = models[ref.modelKey];
    if (!entry) {
      return {
        modelKey: ref.modelKey,
        provider: 'unknown',
        tier: mapTier(ref.modelKey),
        contextWindow: 32768,
        maxOutputTokens: 8192,
        streaming: true,
        toolCalling: 'prompt_protocol',
        usageFields: ['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'other'],
        thinkingModes: [],
        supportsFallback: true,
        evidence: 'unverified',
      };
    }
    return toModelCapability(entry, {
      modelKey: ref.modelKey,
      supportsTemperature: true,
      minTemperature: 0,
      maxTemperature: 2,
      supportsTopP: true,
      minTopP: 0,
      maxTopP: 1,
      supportsReasoning: entry.supportsReasoning ?? false,
      supportsFrequencyPenalty: false,
      supportsPresencePenalty: false,
      supportsStructuredOutput: entry.supportsStructuredOutput ?? false,
      supportsTools: false,
      supportsVision: entry.supportsVision ?? false,
      supportsStreaming: entry.supportsStreaming ?? true,
      supportsJSONMode: entry.supportsStructuredOutput ?? false,
      supportsN: false,
      supportsLogprobs: false,
      maxOutputTokens: entry.maxTokens ?? 8192,
      maxContextTokens: entry.contextWindow ?? 32768,
    }, ref.modelKey);
  },
};

export default cortexModelClient;