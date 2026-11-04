// 能力发现与缓存（R-01 落地：host_registry 种子 → runtime_observed 校准 → unverified）
// 规则：能力表只增事实；运行时观察到的事实才升级；未验证=保守（不开 thinking、不承诺流式）。
import type { ModelCapability, ModelRef, ModelTier } from './types';

export class CapabilityRegistry {
  private caps = new Map<string, ModelCapability>();   // key = modelKey ?? tier

  seed(cap: ModelCapability): void {
    const key = cap.modelKey || cap.tier;
    if (!this.caps.has(key)) this.caps.set(key, cap);
  }

  /** 宿主 modelInfo 同步（E2 EVENT-MP-007）：contextWindow/maxOutputTokens 现成字段 */
  observeFromHost(modelKey: string, provider: string, tier: ModelTier, contextWindow: number, maxOutputTokens: number, toolCalling: ModelCapability['toolCalling'] = 'unsupported', usageFields: ModelCapability['usageFields'] = []): ModelCapability {
    const cap: ModelCapability = {
      modelKey, provider, tier, contextWindow, maxOutputTokens,
      streaming: false,                 // 未实测前保守为 false
      toolCalling, usageFields,
      thinkingModes: [],                // 未验证前 = 无（不伪造）
      supportsFallback: false,
      evidence: 'host_registry',
    };
    this.caps.set(modelKey, cap);
    return cap;
  }

  /** 运行时校准（首次真实调用后） */
  observeRuntime(modelKey: string, patch: Partial<ModelCapability>): ModelCapability {
    const cur = this.caps.get(modelKey);
    const next: ModelCapability = { ...(cur ?? fallbackCap(modelKey)), ...patch, modelKey, evidence: 'runtime_observed', observedAt: new Date().toISOString() };
    this.caps.set(modelKey, next);
    return next;
  }

  describe(ref: ModelRef): ModelCapability {
    const key = ref.modelKey ?? ref.tier;
    return this.caps.get(key) ?? { ...fallbackCap(key), evidence: 'unverified' };
  }

  /** 请求前的能力断言：不支持项→降级清单（可追踪），不伪造 */
  checkRequest(ref: ModelRef, thinking?: { mode: string }): { degraded: Array<{ kind: 'thinking_unsupported'; detail: string }>; allowedThinking?: string } {
    const cap = this.describe(ref);
    const out: Array<{ kind: 'thinking_unsupported'; detail: string }> = [];
    let allowedThinking: string | undefined;
    if (thinking) {
      // 'off' = 不请求思考（DEC-04 默认档），任何模型都支持；其余模式必须在声明集合内
      if (thinking.mode === 'off' || cap.thinkingModes.includes(thinking.mode)) allowedThinking = thinking.mode;
      else out.push({ kind: 'thinking_unsupported', detail: `model ${cap.modelKey} 未声明支持思考模式 ${thinking.mode}（已声明: ${cap.thinkingModes.join(',') || '无'}）；已按 off 处理并记录` });
    }
    return { degraded: out, allowedThinking };
  }
}

function fallbackCap(key: string): ModelCapability {
  return {
    modelKey: key, provider: 'unknown', tier: 'standard',
    contextWindow: 8192, maxOutputTokens: 4096, streaming: false,
    toolCalling: 'unsupported', usageFields: [], thinkingModes: [],
    supportsFallback: false, evidence: 'unverified',
  };
}
