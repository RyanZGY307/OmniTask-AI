// PolicyEngine：工具调用放行判定 + 六机制恢复矩阵（core-data-model §6.3 的代码落地）
// 机制：retry(带退避) / idempotent_replay / degrade(降级继续) / escalate(升级审批) / ask_user / abort
import { assessRisk, type RiskLevel } from './risk';
import type { ApprovalService } from './approval';
import type { ToolSpec } from '../tools/registry';

export type RecoveryMechanism = 'retry' | 'idempotent_replay' | 'degrade' | 'escalate' | 'ask_user' | 'abort';

export interface PolicyVerdict {
  allow: boolean;
  risk: RiskLevel;
  approvalId?: string;             // 需人工时的挂起审批
  mechanism: RecoveryMechanism;    // 被拒绝/失败时的默认恢复机制
  reason: string;
}

export interface PolicyInput {
  spec: ToolSpec;
  args: Record<string, unknown>;
  argsJson: string;
  runId: string;
  stepId: string;
  attempt: number;                 // 第几次尝试（0 起）
  approvals: ApprovalService;
  /** 用户持久授权（host actionPolicies 映射：always 持久化由宿主侧维护，见 security §9.6） */
  persistentGrants?: Array<{ program: string; subcommand?: string }>;
}

/** 恢复机制矩阵（静态表+风险修正；§6.3 六机制的确定性版本） */
export function mechanismFor(risk: RiskLevel, errorKind: string | undefined, attempt: number): RecoveryMechanism {
  if (errorKind === 'guard_rejected' || errorKind === 'denied_command') return 'abort';
  if (errorKind === 'timeout' && attempt < 2) return 'retry';
  if (errorKind === 'nonzero_exit' && attempt < 2) return 'retry';
  if (errorKind === 'bad_args') return 'ask_user';
  if (errorKind === 'context_window_exceeded') return 'degrade';
  if (errorKind === 'rate_limited' || errorKind === 'retryable_transport') return attempt < 3 ? 'retry' : 'escalate';
  if (risk === 'r3') return 'escalate';           // r3 失败→人工升级，绝不自动放行
  if (errorKind === 'not_unique') return 'degrade'; // 参数收窄再试
  return attempt < 2 ? 'retry' : 'escalate';
}

export function evaluate(input: PolicyInput): PolicyVerdict {
  const { spec, args, argsJson, runId, approvals } = input;
  const d = assessRisk(spec, args);
  if (d.level === 'r3') {
    const ap = approvals.request({ runId, stepId: input.stepId, toolId: spec.id, normalizedArgsJson: argsJson, riskLevel: 'r3', summary: `r3: ${spec.id}` });
    return { allow: false, risk: 'r3', approvalId: ap.id, mechanism: 'escalate', reason: `r3 neverAuto: ${d.reasons.join('; ')}` };
  }
  if (d.level === 'r2') {
    const ap = approvals.request({ runId, stepId: input.stepId, toolId: spec.id, normalizedArgsJson: argsJson, riskLevel: 'r2', summary: `r2: ${spec.id}` });
    return { allow: false, risk: 'r2', approvalId: ap.id, mechanism: 'escalate', reason: `r2 需人工授权: ${d.reasons.join('; ')}` };
  }
  if (d.level === 'r1') {
    return { allow: true, risk: 'r1', mechanism: 'retry', reason: 'r1 低风险，可执行+自动重试' };
  }
  return { allow: true, risk: 'r0', mechanism: 'retry', reason: 'r0 只读，放行' };
}

/** 退避（可注入时钟，测试确定性）：attempt 0=0ms,1=500ms,2=2s,≥3=固定8s封顶 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = [0, 500, 2000, 8000][Math.min(attempt, 3)];
  return Math.min(base + Math.floor(random() * 250), 8000);
}
