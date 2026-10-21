import { PROVIDER_BASE_URLS } from '../config';
import { getDynamicModels } from './configSync';
import { getApiKey, reportKeySuccess, reportKeyFailure, getKeyPoolSize, hasAnyKeyInPools } from './apiKeyPool';
import { getProviderBaseUrl } from './providerConfig';
import { getModelCapability, clampTemperature } from './modelCapabilityRegistry';

export async function* chatWithFallback(
  messages: any[],
  modelKey: string,
  maxTokens: number,
  temperature: number,
  availableModels: string[],
): AsyncGenerator<{ type: string; content?: string; model?: string; tokens?: number; usage?: any }> {
  const primary = getDynamicModels()[modelKey];
  if (!primary) { yield { type: 'error', content: `模型 ${modelKey} 不存在` }; return; }

  // Candidate order: requested model first, then router-computed fallbacks.
  // Deduped and capped at 3 to avoid unbounded retry loops.
  const candidates = [modelKey, ...availableModels].filter(Boolean);
  const unique: string[] = [];
  for (const c of candidates) {
    if (getDynamicModels()[c] && !unique.includes(c)) unique.push(c);
    if (unique.length >= 3) break;
  }

  for (let i = 0; i < unique.length; i++) {
    const key = unique[i];
    const info = getDynamicModels()[key];
    if (i > 0) {
      yield { type: 'model_switch', model: key };
    }
    // Each candidate model gets its own final generation parameters.
    // The Temperature Engine's value is re-clamped to this candidate's
    // capability bounds, so switching models never reuses an out-of-bounds
    // temperature from a different model.
    let candidateTemp = temperature;
    try {
      const cap = await getModelCapability(key);
      candidateTemp = clampTemperature(temperature, cap);
    } catch { /* keep temperature as-is on capability lookup failure */ }
    let failed = false;
    let yieldedChunk = false;
    try {
      for await (const chunk of callProvider(messages, key, info.maxTokens || maxTokens, candidateTemp)) {
        if (chunk.type === 'error') {
          failed = true;
          continue; // try next candidate before surfacing
        }
        if (chunk.type === 'chunk') yieldedChunk = true;
        yield chunk;
      }
    } catch (err: any) {
      console.warn(`[MODEL] ${key} failed (${err.message}), trying next candidate`);
      failed = true;
    }
    if (!failed) {
      return; // success on this candidate
    }
    // If content already streamed, don't append a second model's answer.
    if (yieldedChunk || i === unique.length - 1) {
      // 离线兑底：一个可用密钥都没有时，用内置模拟回复保证对话有响应
      // （配置了密钥但调用失败时保留错误提示，避免误导）。
      if (!yieldedChunk && !anyProviderKey()) {
        const reply = buildOfflineReply(messages);
        yield { type: 'chunk', content: reply, model: 'offline-mock' };
        // 真实 token：离线兜底**没有发生任何真实模型调用**，故 tokens 记 0。
        // 原先是 Math.max(1, Math.ceil(reply.length / 2)) —— 把回复文本长度
        // 除 2 造一个数，而这个数会经 chat.ts 的 chunk.tokens 流进
        // tokenCount → 用量统计 → 积分扣除。等于在"没有调用任何模型"的
        // 情况下向用户收 token 费。现在诚实地记 0。
        yield { type: 'done', model: 'offline-mock', tokens: 0 };
        return;
      }
      // 面向用户的错误文案：不暴露内部模型名/调用细节。
      yield { type: 'error', content: failed ? 'AI 服务暂时不可用，请稍后再试' : '所有候选模型均不可用，请稍后再试' };
      return;
    }
  }
}

function anyProviderKey(): boolean {
  return hasAnyKeyInPools();
}

function buildOfflineReply(messages: any[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const q = String(last?.content || '').trim();
  const topic = q.length > 30 ? q.slice(0, 30) + '…' : q;
  if (!q || /^(你好|hi|hello|嗨|在吗|在么)/i.test(q)) {
    return '你好！我是 OmniTask 助手。当前所有外部模型服务都不可用（未配置任何模型密钥或连接全部失败），已自动切换到离线模拟模式，先为你保持对话不中断。\n\n你可以继续提问或描述任务；配置任意模型供应商密钥后，回复会切回真实模型生成。';
  }
  if (/(代码|编程|函数|bug|错误|python|javascript|typescript|java|sql|正则|算法)/i.test(q)) {
    return `收到你的问题：「${topic}」。\n\n当前外部模型服务不可用，这是离线模拟回答，先给你一个可参考的框架：\n\n\`\`\`\nfunction example(input) {\n  // 1. 输入校验\n  if (input == null) throw new Error('缺少输入');\n  // 2. 核心逻辑（请按你的实际问题替换）\n  const result = input;\n  // 3. 异常处理与返回\n  return result;\n}\n\`\`\`\n\n配置模型密钥后，我可以针对你的具体代码做逐行分析与修复建议。`;
  }
  if (/(多少钱|价格|收费|积分|订阅|会员|充值)/.test(q)) {
    return `关于「${topic}」：当前外部模型服务不可用，这是离线模拟回答。\n\n- 价格与积分信息可查看 定价 页面；\n- 历史用量与消耗可在 设置 → 用量统计 中查看；\n- 配置模型密钥后，此处将返回模型生成的正式说明。`;
  }
  return `你问的是：「${topic}」。\n\n当前所有外部模型服务不可用（未配置模型密钥或全部连接失败），已切换到离线模拟模式，先为你保持对话可用。\n\n- 知识类问题：配置任意供应商密钥后我将给出完整解析；\n- 代码任务：请贴出相关代码片段，恢复服务后可逐步分析；\n- 也可在 设置 → 用量统计 查看历史用量与成功率。`;
}
async function* callProvider(messages: any[], modelKey: string, maxTokens: number, temperature: number): AsyncGenerator<any> {
  const model = getDynamicModels()[modelKey];
  if (!model) throw new Error(`Unknown model: ${modelKey}`);
  switch (model.provider) {
    case 'agnes': yield* streamAgnes(messages, model.apiModel, maxTokens, temperature); break;
    case 'deepseek': yield* streamOpenAICompatible(messages, model.apiModel, maxTokens, temperature, 'deepseek'); break;
    case 'openai': yield* streamOpenAICompatible(messages, model.apiModel, maxTokens, temperature, 'openai'); break;
    case 'google': yield* streamGemini(messages, model.apiModel, maxTokens, temperature); break;
    case 'xiaomi': yield* streamOpenAICompatible(messages, model.apiModel, maxTokens, temperature, 'xiaomi'); break;
    default: {
      // custom-<slug> families and any unknown provider: OpenAI-compatible
      // protocol against the provider's admin-configured Base URL.
      yield* streamOpenAICompatible(messages, model.apiModel, maxTokens, temperature, model.provider);
      break;
    }
  }
  yield { type: 'done', model: modelKey };
}

async function* streamAgnes(messages: any[], model: string, maxTokens: number, temperature: number): AsyncGenerator<any> {
  const baseUrl = PROVIDER_BASE_URLS.agnes;
  const poolSize = getKeyPoolSize('agnes');
  for (let attempt = 0; attempt < Math.max(poolSize, 1); attempt++) {
    const apiKey = getApiKey('agnes');
    if (!apiKey) { yield { type: 'error', content: 'No Agnes API key' }; return; }
    const start = Date.now();
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        // stream: true + 逐行解析，与 streamOpenAICompatible 同一套做法。
        // 原先是 stream: false 然后 await res.json() 把整个 completion
        // 一次性读进内存：长回复下这是最典型的「整段吞」，而且用户要等
        // 整个回复生成完才看到第一个字。
        // include_usage 让最后的 usage chunk 带回真实 token —— 见下面的说明。
        body: JSON.stringify({
          model, messages, max_tokens: maxTokens, temperature,
          stream: true, stream_options: { include_usage: true },
        }),
      });
      if (res.ok) {
        if (!res.body) { reportKeyFailure('agnes', apiKey, 'No body'); continue; }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastUsage: any = null;
        let anyContent = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              reportKeySuccess('agnes', apiKey, Date.now() - start);
              // usage 必须是独立的 type:'usage' 事件。
              // 原先是把它挂在 chunk.usage 上发出去，而 chat.ts 的 chunk
              // 分支只读 content/model —— 那个字段根本没人消费，于是
              // Agnes 路径的真实 token 一直是丢的，最后记 0。
              if (lastUsage) yield { type: 'usage', usage: lastUsage };
              return;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.usage) lastUsage = parsed.usage;
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) { anyContent = true; yield { type: 'chunk', content: delta, model: 'agnes' }; }
            } catch {}
          }
        }
        reportKeySuccess('agnes', apiKey, Date.now() - start);
        if (lastUsage) yield { type: 'usage', usage: lastUsage };
        // 流被对端静默关闭且一个 delta 都没给：同样算失败，走外层重试。
        if (!anyContent) { reportKeyFailure('agnes', apiKey, 'empty stream'); continue; }
        return;
      }
      if (res.status === 429 || (res.status as number) >= 500) { reportKeyFailure('agnes', apiKey, `HTTP ${res.status}`); continue; }
      yield { type: 'error', content: `Agnes error: ${res.status}` };
      return;
    } catch (err: any) { reportKeyFailure('agnes', apiKey, err.message); }
  }
  yield { type: 'error', content: 'All Agnes keys exhausted' };
}

async function* streamOpenAICompatible(messages: any[], model: string, maxTokens: number, temperature: number, provider: string): AsyncGenerator<any> {
  const baseUrls: Record<string, string> = PROVIDER_BASE_URLS;
  const baseUrl = baseUrls[provider] || getProviderBaseUrl(provider);
  const maxRetries = getKeyPoolSize(provider);
  let lastUsage: any = null;
  for (let attempt = 0; attempt < Math.max(maxRetries, 1); attempt++) {
    const apiKey = getApiKey(provider);
    if (!apiKey) { yield { type: 'error', content: `No API key for ${provider}` }; return; }
    const start = Date.now();
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: true, stream_options: { include_usage: true } }),
      });
      if (!res.ok) {
        if (res.status === 429 || (res.status as number) >= 500) { reportKeyFailure(provider, apiKey, `HTTP ${res.status}`); continue; }
        yield { type: 'error', content: `${provider} error: ${res.status}` };
        return;
      }
      if (!res.body) { reportKeyFailure(provider, apiKey, 'No body'); continue; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
            while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            reportKeySuccess(provider, apiKey, Date.now() - start);
            if (lastUsage) yield { type: 'usage', usage: lastUsage };
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.usage) lastUsage = parsed.usage;
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) yield { type: 'chunk', content: delta, model };
          } catch {}
        }
      }
      reportKeySuccess(provider, apiKey, Date.now() - start);
      if (lastUsage) yield { type: 'usage', usage: lastUsage };
      return;
    } catch (err: any) { reportKeyFailure(provider, apiKey, err.message); }
  }
  yield { type: 'error', content: `All ${provider} keys exhausted` };
}

async function* streamGemini(messages: any[], model: string, maxTokens: number, temperature: number): AsyncGenerator<any> {
  const baseUrl = PROVIDER_BASE_URLS.google;
  const maxRetries = getKeyPoolSize('google');
  let lastUsage: any = null;
  for (let attempt = 0; attempt < Math.max(maxRetries, 1); attempt++) {
    const apiKey = getApiKey('google');
    if (!apiKey) { yield { type: 'error', content: 'No API key for google' }; return; }
    const start = Date.now();
    try {
      const contents = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const systemMsg = messages.find((m) => m.role === 'system');
      const body: any = { contents, generationConfig: { maxOutputTokens: maxTokens, temperature } };
      if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };
      const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        if (res.status === 429 || (res.status as number) >= 500) { reportKeyFailure('google', apiKey, `HTTP ${res.status}`); continue; }
        yield { type: 'error', content: `google error: ${res.status}` };
        return;
      }
      if (!res.body) { reportKeyFailure('google', apiKey, 'No body'); continue; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.usageMetadata) {
              const um = parsed.usageMetadata;
              lastUsage = {
                prompt_tokens: um.promptTokenCount ?? null,
                completion_tokens: um.candidatesTokenCount ?? null,
                total_tokens: um.totalTokenCount ?? null,
                _provider: 'google',
              };
            }
            const parts = parsed.candidates?.[0]?.content?.parts || [];
            for (const p of parts) {
              if (p.text) yield { type: 'chunk', content: p.text, model };
            }
          } catch {}
        }
      }
      reportKeySuccess('google', apiKey, Date.now() - start);
      if (lastUsage) yield { type: 'usage', usage: lastUsage };
      return;
    } catch (err: any) { reportKeyFailure('google', apiKey, err.message); }
  }
  yield { type: 'error', content: 'All google keys exhausted' };
}
