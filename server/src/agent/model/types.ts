// ModelClient 契约类型（docs/interfaces/model-client-contract.md 2026-10-21 版的代码落地）
// 硬约束：R-01 能力不伪造；R-02 用量四分类；DEC-01 档位默认；DEC-04 思考模式策略。

export type ModelTier = 'light' | 'standard' | 'strong';
export type ModelRole = 'main' | 'advisor' | 'summarizer' | 'verifier';

export interface ModelRef { tier: ModelTier; modelKey?: string; }

export type UsageSource = 'provider' | 'derived' | 'estimated' | 'unavailable';
export type UsagePrecision = 'exact' | 'derived' | 'estimate';

export interface UsageBlock {
  input?: number; output?: number;
  cacheRead?: number; cacheWrite?: number; reasoning?: number;
  other?: Record<string, number>;
  raw?: unknown;                                  // 供应商原始 usage（原样）
  source: UsageSource;                            // 四分类（缺失=unavailable，禁填 0）
  precision: UsagePrecision;
  estimator?: string;                             // source=estimated 必填
}

export interface ModelCapability {
  modelKey: string; provider: string; tier: ModelTier;
  contextWindow: number; maxOutputTokens: number;
  streaming: boolean;
  toolCalling: 'native' | 'prompt_protocol' | 'unsupported';
  usageFields: Array<'input' | 'output' | 'cache_read' | 'cache_write' | 'reasoning' | 'other'>;
  thinkingModes: string[];                        // 未知/不支持 = []（不伪造）
  supportsFallback: boolean;
  evidence: 'provider_docs' | 'runtime_observed' | 'host_registry' | 'unverified';
  observedAt?: string;
}

export type ModelErrorKind =
  | 'retryable_transport' | 'rate_limited' | 'context_window_exceeded'
  | 'content_policy' | 'cost_limit' | 'auth' | 'bad_request'
  | 'capability_missing' | 'unknown';

export interface ToolSpecRef { name: string; description: string; inputSchema: Record<string, unknown>; }

export interface ChatRequest {
  role: ModelRole;
  modelRef: ModelRef;
  systemPrompt: string;
  messages: ModelMessage[];
  tools?: ToolSpecRef[];
  responseFormat?: 'text' | 'json_object';
  maxOutputTokens?: number;
  temperature?: number;
  thinking?: { mode: string; budgetTokens?: number };  // R-01：必须落在 capability.thinkingModes 内
  abortSignal?: { aborted: boolean };
  metadata: { runId: string; stepId: string; taskId: string; attempt: number };
}

export interface ModelMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; name?: string; }

export interface ToolCallRequest { id: string; name: string; args: Record<string, unknown>; }

export interface Degradation { kind: 'thinking_unsupported' | 'streaming_buffered' | 'tools_prompt_protocol' | 'aborted_partial'; detail: string; }

export interface ChatResult {
  text: string;
  toolCalls?: ToolCallRequest[];
  usage: UsageBlock;
  capabilitySnapshot: ModelCapability;
  modelRef: ModelRef;                             // 实际响应模型（fallback 后可不同于请求）
  finishReason: 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error';
  latencyMs: number;
  degraded?: Degradation[];
  errorKind?: ModelErrorKind;
  /** R-11 红线：替身/模拟客户端必须为 true；真实供应商客户端应为 true 语义的显式声明或省略（视为真实）。
   *  事件流（model_call.finished）必须携带该字段，否则 L4 R5 门禁判 violated——禁把模拟当真实供应商汇报。 */
  simulated?: boolean;
}

export interface ChatDelta { text?: string; toolCalls?: ToolCallRequest[]; usage?: UsageBlock; }

export interface ModelClient {
  /** R-11：真实供应商客户端可省略；测试替身必须显式 true（ScriptedModelClient 已是 true） */
  readonly simulated?: boolean;
  chat(req: ChatRequest): Promise<ChatResult>;
  chatStream(req: ChatRequest): AsyncIterable<ChatDelta>;
  describe(ref: ModelRef): ModelCapability;
}
