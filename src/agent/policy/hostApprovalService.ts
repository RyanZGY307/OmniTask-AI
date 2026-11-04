// ================================================================
// HostApprovalService — 把 agent 侧 ApprovalService 落到宿主持久层
// （runbook S4「策略与审批」与宿主 permissionEngine 对齐的桥接层）
//
// 设计取舍（本机 Android 环境的诚实边界）：
//   宿主的 prisma（user 库 / agent 库）在本机因查询引擎架构不匹配无法连接
//   （详见 server/test/permissionEngine.test.ts 的 SKIP 说明）。
//   因此本类把「持久化」与「决策逻辑」分离：
//     - 决策逻辑（映射表 + 状态机）纯同步，全部本地可验证 → L2 覆盖
//     - 持久化（Prisma write）在 db 可用时执行；不可用时降级为内存 + 明确标记
//       persisted=false，UI/审计不得把降级实例当成已落库
// 为何不 import 宿主的 DEFAULT_POLICY（connections/permissionEngine.ts）：
//   宿主 permissionEngine.ts 顶层 `import { prisma } from '../services/db'`，
//   而本机 prisma 查询引擎为 x86_64、运行在 arm64，**构造 PrismaClient 即 dlopen 失败**
//   （不是连接失败，是 require 该模块就抛）——本机权限引擎测试同样崩。为了让
//   S4 的策略/审批逻辑在本机可执行，此处复制其默认策略真值并在注释中标注出处；
//   真值漂移由 test/policyMapping.test.ts 「默认策略逐项相等」用例守护。
// 红线：
//   - r3 恒 confirm：本服务 request() 对 r3 永不返回已批准状态（禁 auto-allow）
//   - approval.decided.by 必须是人：decide() 的 by 参数由宿主 UI 传入真实 userId；
//     本服务不提供任何「系统自动批准」入口（I3 违规即为红线）
//   - DEC-02：单 Run 有效；跨 Run / 跨指纹复用一律拒绝
// ================================================================

import { InMemoryApprovalService, type Approval, type ApprovalDecision, type ApprovalRequestInput, type ApprovalService, type AuthResult } from './approval';
import { agentRiskToHostRisk as RISK_MAP, effectiveDecision, riskMappingSummary } from './riskMapping';
import type { RiskLevel as AgentRiskLevel } from './risk';
import type { ActionPolicy } from '../../connections/types';
import type { Decision } from '../../connections/permissionEngine';

/** 宿主默认策略（connections/permissionEngine.ts:22 DEFAULT_POLICY 的逐项副本；
 *  见文件头「为何不 import」；真值由 policyMapping.test.ts 守护不漂移） */
export const DEFAULT_POLICY: ActionPolicy = {
  R0: 'auto',
  R1: 'auto',
  R2: 'confirm',
  R3: 'confirm',
  R4: 'never',
};

export interface HostApprovalPersistHooks {
  /** 落库（宿主 Prisma approval.create）；不可用时抛错由本类降级 */
  onRequested?(approval: Approval, input: ApprovalRequestInput): Promise<void> | void;
  /** 状态变更落库（approval.update）；同上 */
  onDecided?(approval: Approval): Promise<void> | void;
  /** Run 终态批量过期（approval.updateMany）；同上 */
  onExpired?(runId: string): Promise<void> | void;
}

export interface HostApprovalServiceOptions {
  /** 宿主 userId（run 归属人；审计用） */
  userId?: string;
  /** 事件存储（可选）：decide 成功后补发 approval.decided（宿主 UI 决策痕迹）。
   *  注意：agent 侧 toolTurn 不发射该事件（它只管 tool.* 轨迹），宿主审批入口
   *  （UI/routes）负责 decision 事件——此处把这条接线收在桥接层，避免调用方各自实现。 */
  store?: { append(runId: string, draft: Record<string, unknown>): Promise<unknown> | unknown };
  /** 宿主策略快照；缺省 DEFAULT_POLICY（R0/R1 auto, R2/R3 confirm, R4 never） */
  policy?: ActionPolicy;
  /** 是否真拿到了宿主策略（false = 用默认值，事件/审计须如实标注） */
  policyLoaded?: boolean;
  persist?: HostApprovalPersistHooks;
  /** 强制内存模式（测试/无 DB 环境） */
  inMemoryOnly?: boolean;
}

/** 宿主持久化审批服务：语义与 agent InMemoryApprovalService 完全一致 + 映射标注 + 持久化钩子 */
export class HostApprovalService implements ApprovalService {
  private readonly inner: InMemoryApprovalService;
  private readonly policy: ActionPolicy;
  private readonly policyLoaded: boolean;
  private readonly userId?: string;
  private readonly persist?: HostApprovalPersistHooks;
  private readonly inMemoryOnly: boolean;
  private readonly store?: HostApprovalServiceOptions['store'];
  /** 最近一次降级原因（供宿主/测试诚实标注） */
  lastDegradedReason?: string;

  constructor(opts: HostApprovalServiceOptions = {}) {
    this.inner = new InMemoryApprovalService();
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.policyLoaded = opts.policyLoaded ?? (opts.policy !== undefined);
    this.userId = opts.userId;
    this.persist = opts.persist;
    this.inMemoryOnly = opts.inMemoryOnly ?? false;
    this.store = opts.store;
  }

  // —— 状态机三段（接口与 agent 侧逐字一致）——

  request(input: ApprovalRequestInput): Approval {
    const approval = this.inner.request(input);
    // 落库钩子：失败不阻塞审批流（审批本身以事件流为准），但记下降级原因
    if (!this.inMemoryOnly && this.persist?.onRequested) {
      try {
        const r = this.persist.onRequested(approval, input);
        if (r && typeof (r as Promise<void>).catch === 'function') {
          (r as Promise<void>).catch((e) => { this.lastDegradedReason = `persist.request: ${String(e)}`; });
        }
      } catch (e) {
        this.lastDegradedReason = `persist.request: ${String(e)}`;
      }
    }
    return approval;
  }

  decide(id: string, decision: ApprovalDecision, by: string): AuthResult {
    const result = this.inner.decide(id, decision, by);
    // 决策痕迹（runbook：approval.decided.by 必须是人）。fire-and-forget：事件失败不撤销已落库决策。
    if (result.ok && this.store) {
      const ap = this.inner.get(id);
      if (ap) {
        try {
          const p = this.store.append(ap.runId, {
            type: 'approval.decided', level: 'info',
            payload: {
              approvalId: ap.id, decision, by,
              decidedBy: by,                 // 冗余同名字段：宿主投影按 decidedBy 取人
              riskLevel: ap.riskLevel, hostLevel: RISK_MAP(ap.riskLevel),
              toolFingerprint: ap.toolFingerprint, decidedAt: ap.decidedAt,
            },
          });
          if (p && typeof (p as Promise<unknown>).catch === 'function') {
            (p as Promise<unknown>).catch(() => { /* 事件仅审计用途，失败不回滚决策 */ });
          }
        } catch { /* 同上 */ }
      }
    }
    if (result.ok && !this.inMemoryOnly && this.persist?.onDecided) {
      const ap = this.inner.get(id);
      if (ap) {
        try {
          const r = this.persist.onDecided(ap);
          if (r && typeof (r as Promise<void>).catch === 'function') {
            (r as Promise<void>).catch((e) => { this.lastDegradedReason = `persist.decide: ${String(e)}`; });
          }
        } catch (e) {
          this.lastDegradedReason = `persist.decide: ${String(e)}`;
        }
      }
    }
    return result;
  }

  authorize(runId: string, approvalId: string, versionedToolId: string, normalizedArgsJson: string): AuthResult {
    const result = this.inner.authorize(runId, approvalId, versionedToolId, normalizedArgsJson);
    // 宿主策略复核（runbook S4：authorize 时复检宿主 permissionEngine）
    // 注意：agent 侧 authorize 只管审批状态；宿主侧额外用 effectiveDecision 复核，
    // 但 r3 恒 confirm 的语义在 request() 已强制（未批准前 authorize 必失败），
    // 故此处复核只对「宿主策略降为 never」生效（deny 覆盖已批准项）。
    if (result.ok) {
      const ap = this.inner.get(approvalId);
      if (ap) {
        const hostDecision = effectiveDecision(ap.riskLevel, this.policy);
        if (hostDecision === 'deny') {
          return { ok: false, reason: 'host_policy_denied' };
        }
      }
    }
    return result;
  }

  expireForRun(runId: string): void {
    this.inner.expireForRun(runId);
    if (!this.inMemoryOnly && this.persist?.onExpired) {
      try {
        const r = this.persist.onExpired(runId);
        if (r && typeof (r as Promise<void>).catch === 'function') {
          (r as Promise<void>).catch((e) => { this.lastDegradedReason = `persist.expire: ${String(e)}`; });
        }
      } catch (e) {
        this.lastDegradedReason = `persist.expire: ${String(e)}`;
      }
    }
  }

  pendingFor(runId: string): Approval[] { return this.inner.pendingFor(runId); }
  get(id: string): Approval | undefined { return this.inner.get(id); }

  // —— 宿主侧扩展查询（agent 接口之外，供 UI/路由层）——

  /** 该审批对应的宿主档位与是否人工必须（UI 徽标用） */
  describeRisk(approvalId: string): { hostLevel: string; humanRequired: boolean; hostDecision?: Decision } | undefined {
    const ap = this.inner.get(approvalId);
    if (!ap) return undefined;
    const sum = riskMappingSummary(ap.riskLevel);
    return { ...sum, hostDecision: effectiveDecision(ap.riskLevel, this.policy) };
  }

  /** 宿主策略快照是否真实加载（false = 默认值，UI 须标「策略未加载」） */
  isPolicyLoaded(): boolean { return this.policyLoaded; }

  /** 宿主 userId（undefined = 匿名/测试） */
  ownerUserId(): string | undefined { return this.userId; }
}

// ================================================================
// 便捷工厂：按 userId 从宿主加载策略后构造（异步部分仅此一处）
// ================================================================

/** 用宿主 getPolicy 构造 HostApprovalService；getPolicy 抛错（本机 DB 不可用）时回落默认策略并如实标注 */
export async function createHostApprovalService(
  userId: string | undefined,
  loadPolicy: (uid: string) => Promise<ActionPolicy>,
  persist?: HostApprovalPersistHooks,
): Promise<HostApprovalService> {
  if (!userId) {
    return new HostApprovalService({ policy: DEFAULT_POLICY, policyLoaded: false, persist });
  }
  try {
    const policy = await loadPolicy(userId);
    return new HostApprovalService({ userId, policy, policyLoaded: true, persist });
  } catch (e) {
    // 诚实降级：标注策略未加载 + 默认策略；dev/无 DB 环境可用
    return new HostApprovalService({ userId, policy: DEFAULT_POLICY, policyLoaded: false, persist });
  }
}

export { RISK_MAP as agentRiskToHostRisk, effectiveDecision };
