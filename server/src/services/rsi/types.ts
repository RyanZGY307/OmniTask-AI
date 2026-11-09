// ================================================================
// RSI 共享类型（纯类型，无 IO）。所有模块共用，避免循环依赖。
// ================================================================

export type ActorKind = 'user' | 'agent' | 'worker' | 'subagent' | 'service' | 'plugin' | 'admin';

export type AssetAction =
  | 'read' | 'propose' | 'approve' | 'publish' | 'pause' | 'rollback'
  | 'register' | 'experiment' | 'view_audit';

/** 资产类型白名单：只有列在这里的类型才允许自动实验/发布。 */
export const AUTO_EXPERIMENTABLE: readonly string[] = [
  'skill_guidance',
  'prompt_atom_authorized',
  'scenario_experimental',
  'knowledge_fact',
  'knowledge_object',
];

/** 资产类型黑名单：命中即拒绝，且优先级高于白名单（名称命中不可信，按类型判）。 */
export const PROTECTED_TYPES: readonly string[] = [
  'system_prompt', 'guardrail', 'auth', 'permission', 'authorization',
  'tool_capability', 'bash_script', 'plugin', 'privileged_subagent',
  'backend_source', 'migration', 'env_secret', 'rsi_self',
  'user_personal_memory', 'cross_user_private',
];

export type RiskLevel = 'r0' | 'r1' | 'r2' | 'r3';

export type ChangeStatus =
  | 'pending' | 'awaiting_approval' | 'approved' | 'rejected'
  | 'evaluating' | 'canary' | 'released' | 'failed' | 'rolled_back';

/** 全局紧急暂停：PAUSE_ALL_WRITES=1 时所有自动写入 fail-closed。 */
export function isPauseAllWrites(): boolean {
  return process.env.PAUSE_ALL_WRITES === '1';
}

export const CHANGE_TRANSITIONS: Record<string, string[]> = {
  pending: ['awaiting_approval', 'evaluating', 'rejected', 'failed'],
  evaluating: ['awaiting_approval', 'rejected', 'failed', 'canary'],
  awaiting_approval: ['approved', 'rejected', 'failed'],
  approved: ['canary', 'failed', 'released'],
  canary: ['released', 'rolled_back', 'failed', 'awaiting_approval'],
  released: ['rolled_back'],
  failed: [],
  rejected: [],
  rolled_back: [],
};

export interface Actor {
  kind: ActorKind;
  id: string;
  role?: string;        // 仅 user/admin 有意义
  ownerId?: string;     // 资产所有者
}

export interface AssetRef {
  assetType: string;
  assetKey: string;
  ownerId?: string | null;
  scope?: string;       // user / team / global
}

export interface ProposalPayload {
  assetType: string;
  assetKey: string;
  content: string;          // 建议内容（PromptAtom instruction / Skill guidance / knowledge claim 等）
  hypothesis: string;
  changeKind: string;       // add / modify / retire
  instructionDelta?: string; // 相对当前版本的差异说明
}

export interface EvidenceBundle {
  signals: Array<{ signalId: string; signalType: string; severity: string; createdAt: string; detail?: string }>;
  contextSummary: string;          // 已脱敏的执行上下文摘要
  baseline: BaselineSnapshot;
  history: EvaluationSummary[];
  currentVersion: number | null;
  relatedChanges: number;
  assembledAt: string;
}

export interface BaselineSnapshot {
  windowHours: number;
  samples: number;
  metrics: Record<string, number>;
  sourceIds: string[];
}

export interface EvaluationSummary {
  evaluationId: string;
  changeId: string;
  decision: string;
  metrics?: Record<string, number>;
  createdAt: string;
}

export interface MetricSample {
  sampleCount: number;
  windowHours: number;
  metrics: Record<string, number>;
  sourceIds: string[];
}
