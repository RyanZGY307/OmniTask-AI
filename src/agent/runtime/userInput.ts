// UserInputRequest 服务与 Inbox 六类输入判别（task-events-and-user-input §7 的代码落地）
// 纪律：UserInputRequest 管信息索取（低风险），与 Approval 高风险授权互不替代（core-data-model §6.2）。
import type { InputKind, InputState } from '../events/types';

export interface UserInputRequest {
  id: string;
  runId: string;
  stepId?: string;
  kind: InputKind;
  prompt: string;
  options?: Array<{ label: string; value: string }>;
  allowCustom: boolean;
  answer?: { selected?: string[]; custom?: string };
  state: InputState;
  createdAt: string;
  answeredAt?: string;
}

export interface UserInputService {
  ask(input: { runId: string; stepId?: string; kind: InputKind; prompt: string; options?: Array<{ label: string; value: string }>; allowCustom?: boolean }): UserInputRequest;
  answer(id: string, answer: { selected?: string[]; custom?: string }): { ok: true } | { ok: false; reason: string };
  pendingFor(runId: string): UserInputRequest[];
  get(id: string): UserInputRequest | undefined;
}

export class InMemoryUserInputService implements UserInputService {
  private items = new Map<string, UserInputRequest>();
  private seq = 0;

  ask(input: { runId: string; stepId?: string; kind: InputKind; prompt: string; options?: Array<{ label: string; value: string }>; allowCustom?: boolean }): UserInputRequest {
    const id = `ui_${++this.seq}`;
    const r: UserInputRequest = {
      id, runId: input.runId, stepId: input.stepId, kind: input.kind, prompt: input.prompt,
      options: input.options, allowCustom: input.allowCustom ?? true,
      state: 'pending', createdAt: new Date().toISOString(),
    };
    this.items.set(id, r);
    return r;
  }

  answer(id: string, answer: { selected?: string[]; custom?: string }): { ok: true } | { ok: false; reason: string } {
    const r = this.items.get(id);
    if (!r) return { ok: false, reason: 'not_found' };
    if (r.state !== 'pending') return { ok: false, reason: `not_pending(${r.state})` };
    if (r.kind !== 'confirm_target' && (answer.selected ?? []).length === 0 && !answer.custom) {
      return { ok: false, reason: 'empty_answer' };
    }
    if (r.options && answer.selected?.some((s) => !r.options!.some((o) => o.value === s))) {
      return { ok: false, reason: 'option_not_in_list' };
    }
    if (answer.custom && !r.allowCustom) return { ok: false, reason: 'custom_not_allowed' };
    r.answer = answer;
    r.state = 'answered';
    r.answeredAt = new Date().toISOString();
    return { ok: true };
  }

  pendingFor(runId: string): UserInputRequest[] {
    return [...this.items.values()].filter((r) => r.runId === runId && r.state === 'pending');
  }

  get(id: string): UserInputRequest | undefined { return this.items.get(id); }
}

// —— Inbox 六类输入判别（execution-flow 场景 F；M1 为规则+宿主状态混合，经 LLM 精判为后续增强）——
export type InboxCategory =
  | 'new_task'          // 新任务
  | 'append_instruction'// 追加指令（作用于活跃 Run）
  | 'userinput_reply'   // 用户输入回复
  | 'approval_decision' // 审批决定
  | 'cancel'            // 取消
  | 'chat';             // 纯聊天

export interface InboxInput {
  text: string;
  hasActiveRun: boolean;
  pendingUserInputId?: string;
  pendingApprovalId?: string;
}

export interface InboxVerdict {
  category: InboxCategory;
  targetId?: string;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
}

/** 判别器：**退役/终态 Run 的输入永不当 userinput_reply**（TB 知情语义）；纯规则可判就走规则，其余 medium/low 交上层。 */
export function classifyInbox(input: InboxInput): InboxVerdict {
  const t = input.text.trim();
  if (input.pendingApprovalId && /^(批准|同意|通过|approve|yes|ok\b)/i.test(t)) {
    return { category: 'approval_decision', targetId: input.pendingApprovalId, confidence: 'high', rationale: '存在 pending 审批且命中批准语' };
  }
  if (input.pendingApprovalId && /^(拒绝|否决|deny|no$)/i.test(t)) {
    return { category: 'approval_decision', targetId: input.pendingApprovalId, confidence: 'high', rationale: '存在 pending 审批且命中拒绝语' };
  }
  if (input.pendingUserInputId) {
    return { category: 'userinput_reply', targetId: input.pendingUserInputId, confidence: 'high', rationale: '存在 pending UserInputRequest，默认视为其回复' };
  }
  if (!input.hasActiveRun) {
    return { category: 'new_task', confidence: 'high', rationale: '无活跃 Run' };
  }
  if (/^(取消|停下|stop|cancel)/i.test(t)) {
    return { category: 'cancel', confidence: 'high', rationale: '命中取消指令' };
  }
  if (/^(继续|补充|另外|然后|接着|continue|also|and then)/.test(t)) {
    return { category: 'append_instruction', confidence: 'medium', rationale: '命中追加语，作用于活跃 Run' };
  }
  return { category: 'chat', confidence: 'low', rationale: '默认按聊天处理（可由 LLM 精判升档）' };
}
