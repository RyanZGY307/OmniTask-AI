// Agent 任务 UI 的视图模型类型 —— 镜像 server/src/agent/ui/taskView.ts 的契约（TaskCardVM/TaskEventRowVM/TaskPhase）。
// 纪律：前端只渲染服务端返回的 VM 字段；卡片/事件行一律由服务端从事件流投影（唯一事实源 = 事件），
// 本文件不含任何本地状态推断逻辑（禁乐观渲染）。

export type TaskPhase =
  | 'created' | 'selected' | 'running' | 'waiting_approval' | 'waiting_user'
  | 'compacting' | 'restoring' | 'completed' | 'failed' | 'canceled' | 'budget_exhausted';

export interface TaskCardVM {
  runId: string;
  pattern?: string;
  patternLabel?: string;
  phase: TaskPhase;
  steps: number;
  approvalsPending: number;
  userInputsPending: number;
  lastEventType: string | null;
  lastEventSeq: number;
  finalText?: string;
  errorKind?: string;
  downgradedFrom?: string;
}

export interface TaskEventRowVM {
  seq: number;
  type: string;
  level: 'info' | 'warn' | 'error';
  ts: string;
  summary: string;
}

export interface AgentRunRow {
  id: string;
  taskId: string;
  state: string;
  modelTier: string;
  depth: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingApprovalVM {
  id: string;
  summary: string;
  riskLevel: string;
  state: string;
  toolFingerprint: string;
}

export interface AgentCapabilities {
  checkpoints: boolean;
  subagents: boolean;
  skills: boolean;
  advisor: boolean;
  mcp: boolean;
}

/** TaskPhase 11 态的展示文案与色调（纯展示，不含逻辑） */
export const PHASE_META: Record<TaskPhase, { label: string; tone: 'gray' | 'blue' | 'amber' | 'green' | 'red' | 'purple' }> = {
  created: { label: '已创建', tone: 'gray' },
  selected: { label: '已选架构', tone: 'blue' },
  running: { label: '运行中', tone: 'blue' },
  waiting_approval: { label: '等待审批', tone: 'amber' },
  waiting_user: { label: '等待用户', tone: 'amber' },
  compacting: { label: '压缩中', tone: 'purple' },
  restoring: { label: '恢复中', tone: 'purple' },
  completed: { label: '已完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  canceled: { label: '已取消', tone: 'gray' },
  budget_exhausted: { label: '预算耗尽', tone: 'red' },
};

const TONE_CLASS: Record<string, string> = {
  gray: 'bg-gray-100 text-gray-700',
  blue: 'bg-blue-100 text-blue-700',
  amber: 'bg-amber-100 text-amber-800',
  green: 'bg-green-100 text-green-700',
  red: 'bg-red-100 text-red-700',
  purple: 'bg-purple-100 text-purple-700',
};

export function phaseBadgeClass(phase: TaskPhase): string {
  return `inline-block px-2 py-0.5 rounded text-xs font-medium ${TONE_CLASS[PHASE_META[phase].tone]}`;
}
