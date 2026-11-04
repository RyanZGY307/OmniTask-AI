// 运行级 Compactor（C0–C3）：与宿主对话级压缩器解耦（ADR-004 分裂的代码落地）
// 触发：上下文窗口占用（capability.contextWindow 的 70% 软阈值/85% 硬阈值）。
// C0 仅截断旧工具观察（零模型）；C1 模型摘要旧轮次；C2 checkpoint 落事件存储；
// C3 重组为"摘要+近窗+关键工件引用"三段。红线：user.input 原话与进行中审批/提问**永不压缩**。
import type { ModelClient } from '../model/types';
import type { ModelMessage } from '../model/types';

export type CompactLevel = 'c0' | 'c1' | 'c2' | 'c3';

export interface CompactionPolicy {
  softRatio: number;   // 默认 0.70
  hardRatio: number;   // 默认 0.85
}

export const DEFAULT_POLICY: CompactionPolicy = { softRatio: 0.7, hardRatio: 0.85 };

/** 占用估算：字符/4≈token（估算器必须显式声明，R-02） */
export function estimateTokens(messages: ModelMessage[]): { tokens: number; estimator: string } {
  const chars = messages.reduce((n, m) => n + (m.content?.length ?? 0) + 64, 0);
  return { tokens: Math.ceil(chars / 4), estimator: 'chars/4+msg-overhead-64' };
}

export function pickLevel(usageRatio: number, policy: CompactionPolicy = DEFAULT_POLICY): CompactLevel | null {
  if (usageRatio >= policy.hardRatio) return 'c3';
  if (usageRatio >= policy.softRatio) return 'c2';
  return null;
}

/** C0：截断最旧 N 条 tool 观察为占位（保留 user 消息与最近 K 条） */
export function c0Compact(messages: ModelMessage[], keepRecent = 4): { messages: ModelMessage[]; dropped: number } {
  const lastToolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const cutoff = Math.max(0, messages.length - keepRecent);
  let dropped = 0;
  const out = messages.map((m, i) => {
    if (m.role === 'tool' && i < cutoff && lastToolIdx.indexOf(i) !== -1) {
      dropped++;
      return { ...m, content: '[observation elided by C0]' };
    }
    return m;
  });
  return { messages: out, dropped };
}

/** C1：模型摘要旧轮次（除保护对象外）；失败→回落 C0（不伪造摘要） */
export async function c1Compact(model: ModelClient, messages: ModelMessage[], opts: { protectedRoles: Array<ModelMessage['role']>; keepRecent: number }): Promise<{ messages: ModelMessage[]; summary: string | null }> {
  const keep = messages.slice(-opts.keepRecent);
  const oldAll = messages.slice(0, -opts.keepRecent);
  const protectedOld = oldAll.filter((m) => opts.protectedRoles.includes(m.role));  // 原样保留（红线）
  const summarizable = oldAll.filter((m) => !opts.protectedRoles.includes(m.role));
  if (summarizable.length === 0) return { messages, summary: null };
  const res = await model.chat({
    role: 'summarizer', modelRef: { tier: 'light' },
    systemPrompt: '你是压缩器：把给定历史压缩为一段忠实摘要，保留目标、关键决策、未完成事项；不得编造。',
    messages: [{ role: 'user', content: summarizable.map((m) => `${m.role}: ${m.content}`).join('\n') }],
    metadata: { runId: 'compact', stepId: 'c1', taskId: 'compact', attempt: 0 },
  });
  if (res.finishReason === 'error') {
    const c0 = c0Compact(messages, opts.keepRecent);
    return { messages: c0.messages, summary: null };
  }
  // 结构：受保护原文（保序） + 摘要 + 近窗
  return { messages: [...protectedOld, { role: 'assistant', content: `[compacted] ${res.text}` }, ...keep], summary: res.text };
}
