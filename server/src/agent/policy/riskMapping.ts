// ================================================================
// 风险档位映射：OmniTask-Agent r0–r3 ↔ cortex 宿主 R0–R4
// （runbook S4「策略与审批」的代码落地；红线表见文件末尾）
//
// 语义边界（**不得混淆**）：
//   agent r3 = 「每次执行都要人工批准」（高频但可执行）
//   host  R4 = 「永不执行」（敏感/资金类，用户策略可封顶）
// 二者语义不同 → r3 绝不映射到 R4；runbook 明令禁止。
// ================================================================

import type { RiskLevel as AgentRiskLevel } from './risk';
import type { RiskLevel as HostRiskLevel, ActionPolicy } from '../../connections/types';
import type { Decision } from '../../connections/permissionEngine';

/** 映射表（runbook S4 原表）：
 *    r0 → R0 auto    （只读，宿主自主）
 *    r1 → R1 auto    （低影响写，宿主自主）
 *    r2 → R2 confirm （外部通信等，需确认）
 *    r3 → R3 + 禁 auto 标记 → confirm（每次人工批准）
 */
export const RISK_LEVEL_MAP: Record<AgentRiskLevel, HostRiskLevel> = {
  r0: 'R0',
  r1: 'R1',
  r2: 'R2',
  r3: 'R3',
};

/** agent r3 的宿主档位在此表中查得；用于 policyEngine 调度与审计标注 */
export function agentRiskToHostRisk(agent: AgentRiskLevel): HostRiskLevel {
  return RISK_LEVEL_MAP[agent];
}

/** 反向：宿主档位 → agent 档位（仅用于宿主侧展示/审计，R4 无对应 agent 档） */
export function hostRiskToAgentRisk(host: HostRiskLevel): AgentRiskLevel | null {
  for (const [a, h] of Object.entries(RISK_LEVEL_MAP)) {
    if (h === host) return a as AgentRiskLevel;
  }
  return null;   // R4：agent 侧无等价档（宿主专属封顶）
}

/** 该 agent 档位是否「每次必须人工」（映射到宿主 confirm 语义） */
export function requiresHumanEachTime(agent: AgentRiskLevel): boolean {
  return agent === 'r2' || agent === 'r3';
}

// ================================================================
// 决策函数：agent 档位 + 宿主策略 → 宿主 Decision
// 红线（runbook S4，「宿主的 always 持久授权不得覆盖本仓库 r3」）：
//   1. r3 恒 confirm —— 无论宿主策略是 auto/confirm/always/never
//      （宿主 'always' 当前是 'confirm' 的别名，语义上刚好一致；
//        但此处显式编码，未来宿主若引入真·always 也不得放行 r3）
//   2. r3 不得映射到 R4 —— 语义不同（见文件头）
//   3. r2 走宿主 R2 策略：auto→allow / confirm|always→confirm / never→deny
//   4. r0/r1 走宿主 R0/R1 策略：never→deny，其余 allow/confirm
// ================================================================
export function effectiveDecision(agent: AgentRiskLevel, policy: ActionPolicy): Decision {
  // 红线 1+2：r3 恒 confirm（写死，不经宿主策略）
  if (agent === 'r3') return 'confirm';
  // 红线 2 复核：R4 永不到达此分支（映射表无 r4 项）
  const hostLevel = RISK_LEVEL_MAP[agent];
  const v = policy[hostLevel];
  if (v === 'never') return 'deny';
  if (v === 'auto') return 'allow';
  // confirm / always → confirm（宿主 'always' 是 confirm 别名）
  return 'confirm';
}

/** 供审计/事件流：agent 档位 → 宿主档位 + 是否禁 auto（事件 payload 用） */
export function riskMappingSummary(agent: AgentRiskLevel): { hostLevel: HostRiskLevel; humanRequired: boolean } {
  return { hostLevel: RISK_LEVEL_MAP[agent], humanRequired: requiresHumanEachTime(agent) };
}

// ================================================================
// 自检（防止将来者把映射表改错；跑 `tsx riskMapping.ts` 即可验证）
// ================================================================
if (require.main === module) {
  const P_DEFAULT: ActionPolicy = { R0: 'auto', R1: 'auto', R2: 'confirm', R3: 'confirm', R4: 'never' };
  const P_ALL_AUTO: ActionPolicy = { R0: 'auto', R1: 'auto', R2: 'auto', R3: 'auto', R4: 'auto' };
  const cases: Array<[string, boolean]> = [
    ['r0 默认 auto→allow', effectiveDecision('r0', P_DEFAULT) === 'allow'],
    ['r1 默认 auto→allow', effectiveDecision('r1', P_DEFAULT) === 'allow'],
    ['r2 默认 confirm→confirm', effectiveDecision('r2', P_DEFAULT) === 'confirm'],
    ['r3 默认 confirm→confirm', effectiveDecision('r3', P_DEFAULT) === 'confirm'],
    ['r3 在宿主全 auto 下仍 confirm（红线1）', effectiveDecision('r3', P_ALL_AUTO) === 'confirm'],
    ['r2 在宿主 auto 下→allow', effectiveDecision('r2', P_ALL_AUTO) === 'allow'],
    ['r0 宿主 never→deny', effectiveDecision('r0', { ...P_DEFAULT, R0: 'never' }) === 'deny'],
    ['r3 不映射到 R4', RISK_LEVEL_MAP.r3 === 'R3'],
    ['R4 无 agent 反向档', hostRiskToAgentRisk('R4') === null],
  ];
  let fail = 0;
  for (const [name, ok] of cases) {
    if (ok) console.log('  PASS', name); else { fail++; console.log('  FAIL', name); }
  }
  console.log(fail === 0 ? `\nriskMapping 自检：${cases.length} 通过` : `\nriskMapping 自检：${fail} 失败`);
  process.exitCode = fail > 0 ? 1 : 0;
}
