// 宿主运行时单例：把 agent 的 AgentLoop 接到宿主真实依赖上（runbook §1「实现类按宿主形态重写一薄层」）。
// 注入（唯一事实源 discipline）：
//   - EventStore   = prismaEventStore（agent 库，S2 已落）
//   - ModelClient  = cortexModelClient（S3：包装宿主 chatWithFallback，走宿主 key pool/fallback/限流）
//   - ToolRegistry = agent 注册表 + writeTools（bash 路径白名单在 Guard 内，宿主 shell 语义复核见 §4 未验证清单）
//   - ApprovalService = HostApprovalService（S4：内存权威 + 持久化到 agent 库 Approval 表 + 桥接事件）
// 不注入的 M3 能力（checkpoints/subagents/skills/advisor/mcp）保持关闭，capabilities() 如实返回 false（S6：不可用不伪造）。

import { AgentLoop, type RunRequest, type RunHandle } from './agentLoop';
import { prismaEventStore, agentPrisma } from '../events/prismaEventStore';
import { cortexModelClient } from '../model/agentModelClient';
import { ToolRegistry } from '../tools/registry';
import { registerWriteTools } from '../tools/writeTools';
import { HostApprovalService } from '../policy/hostApprovalService';
import type { Approval, ApprovalRequestInput } from '../policy/approval';

const DEFAULT_WORKSPACE = process.env.AGENT_WORKSPACE_ROOT || process.cwd();

/** 把 agent 审批行持久化到 agent 库 Approval 表（字段映射：decidedBy↔decisionBy） */
function makePersistHooks() {
  return {
    async onRequested(approval: Approval, input: ApprovalRequestInput): Promise<void> {
      try {
        await agentPrisma.approval.create({
          data: {
            id: approval.id,
            runId: approval.runId,
            stepId: approval.stepId ?? null,
            toolFingerprint: approval.toolFingerprint,
            riskLevel: approval.riskLevel as any,
            summary: approval.summary,
            state: 'pending',
            expiresAt: new Date(Date.now() + 24 * 3600 * 1000), // DEC-02：真正过期由 expireForRun 在 Run 终态触发
          },
        });
      } catch (e) {
        // 持久化失败不阻塞内存权威路径（降级已在 HostApprovalService 标注）
        console.warn('[agent/approval] persist onRequested failed:', (e as Error).message);
      }
    },
    async onDecided(approval: Approval): Promise<void> {
      try {
        await agentPrisma.approval.update({
          where: { id: approval.id },
          data: {
            state: approval.state as any,
            decisionBy: approval.decidedBy ?? null, // Prisma 字段名 decisionBy ↔ TS decidedBy
            decidedAt: approval.decidedAt ? new Date(approval.decidedAt) : new Date(),
          },
        });
      } catch (e) {
        console.warn('[agent/approval] persist onDecided failed:', (e as Error).message);
      }
    },
    async onExpired(runId: string): Promise<void> {
      try {
        await agentPrisma.approval.updateMany({
          where: { runId, state: 'pending' },
          data: { state: 'expired' },
        });
      } catch (e) {
        console.warn('[agent/approval] persist onExpired failed:', (e as Error).message);
      }
    },
  };
}

let loop: AgentLoop | null = null;
let approvals: HostApprovalService | null = null;
const handles = new Map<string, RunHandle>();       // runId → 最近一次 RunHandle（resume 用）
const requests = new Map<string, RunRequest>();      // runId → RunRequest（resume 重建 ctx 用）
const running = new Set<string>();                   // runId → 后台执行中

function buildLoop(): AgentLoop {
  const tools = new ToolRegistry();
  registerWriteTools(tools, [DEFAULT_WORKSPACE]);
  approvals = new HostApprovalService({
    userId: 'system', // 工厂占位；真正 decide 时以人类 userId 为准（红线）
    inMemoryOnly: false,
    store: prismaEventStore as any, // 桥接层用 store 补发 approval.decided 事件
    persist: makePersistHooks(),
  });
  loop = new AgentLoop({
    store: prismaEventStore,
    model: cortexModelClient,
    tools,
    approvals,
    // M3 能力刻意不注入 → capabilities() 全 false，UI 显示「不可用」而非伪造（S6）
  });
  return loop;
}

export function getAgentLoop(): AgentLoop {
  return loop ?? buildLoop();
}

export function getApprovalService(): HostApprovalService {
  getAgentLoop();
  return approvals!;
}

/** RunOutcome.state → Prisma RunStatus（枚举同名，直接映射） */
function toRunStatus(state: string): any {
  switch (state) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'canceled': return 'canceled';
    case 'budget_exhausted': return 'budget_exhausted';
    case 'waiting_approval': return 'waiting_approval';
    case 'waiting_user': return 'waiting_user';
    default: return 'running';
  }
}

export interface StartRunInput {
  taskId?: string;
  conversationId?: string;
  userId: string;
  objective: string;
  userMessage: string;
  workspaceRoots?: string[];
  /** free=3 档 / pro=7 档（pattern 门禁）；缺省按宿主订阅档，这里默认 pro */ 
  tier?: 'free' | 'pro';
}

/** 建 Task（如需要）+ Run 行，后台跑 AgentLoop，返回 runId。状态变更一律落 Run 表 + 事件流。 */
export async function startRun(input: StartRunInput): Promise<{ runId: string; taskId: string }> {
  const l = getAgentLoop();
  let taskId = input.taskId;
  if (!taskId) {
    const task = await agentPrisma.task.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId ?? null,
        title: input.objective.slice(0, 80),
        objective: input.objective,
      },
    });
    taskId = task.id;
  }
  const run = await agentPrisma.run.create({
    data: { id: undefined as any, taskId, state: 'created', modelTier: 'standard', depth: 'd2' } as any,
  });
  const runId = run.id;

  const req: RunRequest = {
    runId,
    taskId,
    userId: input.userId,
    conversationId: input.conversationId,
    objective: input.objective,
    userMessage: input.userMessage,
    tier: input.tier ?? 'pro',
    signals: { dependencyDepth: 1, goalAmbiguity: 1, riskSideEffect: 1, irreversibility: 1, externalToolNeed: 0, recoveryCost: 1, verifiability: 2 },
    workspaceRoots: input.workspaceRoots?.length ? input.workspaceRoots : [DEFAULT_WORKSPACE],
    limits: { maxSteps: 12, maxModelCalls: 12 },
  };
  requests.set(runId, req);
  running.add(runId);
  // 后台执行；不阻塞 HTTP 响应（UI 通过 GET /runs/:runId 或 SSE 看事件翻转）
  (async () => {
    try {
      await agentPrisma.run.update({ where: { id: runId }, data: { state: 'running' } }).catch(() => {});
      const handle = await l.start(req);
      handles.set(runId, handle);
      await agentPrisma.run.update({ where: { id: runId }, data: { state: toRunStatus(handle.outcome.state) } }).catch(() => {});
    } catch (e) {
      console.error('[agent/hostRuntime] run failed:', e);
      await agentPrisma.run.update({ where: { id: runId }, data: { state: 'failed' } }).catch(() => {});
    } finally {
      running.delete(runId);
    }
  })();
  return { runId, taskId };
}

/** 人工审批决定 → 桥接层记状态并补发 approval.decided → resume 该 Run（幂等重放由指纹保证） */
export async function decideApproval(approvalId: string, decision: 'approved' | 'denied', by: string): Promise<{ ok: boolean; reason?: string; runId?: string }> {
  const svc = getApprovalService();
  const ap = svc.get(approvalId);
  if (!ap) return { ok: false, reason: 'approval_not_found' };
  const r = svc.decide(approvalId, decision, by);
  if (!r.ok) return { ok: false, reason: r.reason };

  const runId = ap.runId;
  const handle = handles.get(runId);
  const req = requests.get(runId);
  if (!handle || !req) return { ok: true, runId }; // 决定已生效；无内存 handle 时下次 start 会重放（事件流兜底）
  running.add(runId);
  (async () => {
    try {
      const l = getAgentLoop();
      // decisionKey = toolFingerprint（`${toolId}|${argsJson}`），与 runner 的 ctx.decisions 短路键一致
      const next = await l.resume(handle, { [ap.toolFingerprint]: decision });
      handles.set(runId, next);
      await agentPrisma.run.update({ where: { id: runId }, data: { state: toRunStatus(next.outcome.state) } }).catch(() => {});
    } catch (e) {
      console.error('[agent/hostRuntime] resume failed:', e);
      await agentPrisma.run.update({ where: { id: runId }, data: { state: 'failed' } }).catch(() => {});
    } finally {
      running.delete(runId);
    }
  })();
  return { ok: true, runId };
}

export function isRunning(runId: string): boolean {
  return running.has(runId);
}
