// 审批状态机（DEC-02：单 Run 有效；跨 Run/跨指纹复用拒绝）
// 语义边界：UserInputRequest 管信息索取；Approval 管高风险授权——互不替代（core-data-model §6.2）
// 统一约定：toolId = versioned id（`name@semver`），与 ToolSpec.id 一致；指纹 = toolId + 规范化参数 hash。
import { toolFingerprint } from '../events/ids';
import type { RiskLevel } from './risk';

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'canceled';
export type ApprovalDecision = 'approved' | 'denied';

export interface Approval {
  id: string;
  runId: string;
  stepId?: string;
  toolFingerprint: string;
  riskLevel: RiskLevel;
  summary: string;
  state: ApprovalState;
  expiresAt: string;             // DEC-02：默认=Run 终态时刻（单 Run 有效）
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
}

export interface ApprovalRequestInput {
  runId: string; stepId?: string;
  toolId: string;               // versioned
  normalizedArgsJson: string;
  riskLevel: RiskLevel; summary: string;
}

export type AuthResult = { ok: true; reason?: string } | { ok: false; reason: string };

export interface ApprovalService {
  request(input: ApprovalRequestInput): Approval;
  decide(id: string, decision: ApprovalDecision, by: string): AuthResult;
  /** 审批后执行前复检（宿主 approveAction 范式）：当前是否可放行 */
  authorize(runId: string, approvalId: string, versionedToolId: string, normalizedArgsJson: string): AuthResult;
  expireForRun(runId: string): void;           // Run 终态时调用
  pendingFor(runId: string): Approval[];
  get(id: string): Approval | undefined;
}

export class InMemoryApprovalService implements ApprovalService {
  private items = new Map<string, Approval>();
  private seq = 0;

  request(input: ApprovalRequestInput): Approval {
    const fp = toolFingerprint(input.toolId, input.normalizedArgsJson);
    // 同 Run 同指纹 pending 复用（防重复弹卡）
    for (const a of this.items.values()) {
      if (a.runId === input.runId && a.toolFingerprint === fp && a.state === 'pending') return a;
    }
    const id = `ap_${++this.seq}`;
    const ap: Approval = {
      id, runId: input.runId, stepId: input.stepId, toolFingerprint: fp,
      riskLevel: input.riskLevel, summary: input.summary, state: 'pending',
      expiresAt: 'run-terminal', createdAt: new Date().toISOString(),
    };
    this.items.set(id, ap);
    return ap;
  }

  decide(id: string, decision: ApprovalDecision, by: string): AuthResult {
    const ap = this.items.get(id);
    if (!ap) return { ok: false, reason: 'approval_not_found' };
    if (ap.state !== 'pending') return { ok: false, reason: `not_pending(${ap.state})` };
    ap.state = decision;
    ap.decidedBy = by;
    ap.decidedAt = new Date().toISOString();
    return { ok: true };
  }

  authorize(runId: string, approvalId: string, versionedToolId: string, normalizedArgsJson: string): AuthResult {
    const ap = this.items.get(approvalId);
    if (!ap) return { ok: false, reason: 'approval_not_found' };
    if (ap.runId !== runId) return { ok: false, reason: 'cross_run_reuse_denied' };            // DEC-02 红线
    if (ap.state === 'expired' || ap.state === 'canceled') return { ok: false, reason: `state_${ap.state}` };
    if (ap.state === 'pending') return { ok: false, reason: 'not_decided' };
    if (ap.state === 'denied') return { ok: false, reason: 'denied' };
    const fp = toolFingerprint(versionedToolId, normalizedArgsJson);
    if (fp !== ap.toolFingerprint) return { ok: false, reason: 'fingerprint_mismatch' };        // 审批必须绑定参数
    return { ok: true };
  }

  expireForRun(runId: string): void {
    for (const ap of this.items.values()) {
      if (ap.runId === runId && ap.state === 'pending') { ap.state = 'expired'; ap.decidedAt = new Date().toISOString(); }
    }
  }

  pendingFor(runId: string): Approval[] {
    return [...this.items.values()].filter((a) => a.runId === runId && a.state === 'pending');
  }

  get(id: string): Approval | undefined { return this.items.get(id); }
}
