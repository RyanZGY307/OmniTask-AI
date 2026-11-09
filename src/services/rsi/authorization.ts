// ================================================================
// 统一权限判定 can()：主体 + 动作 + 资产 + 风险 + 范围 + 生命周期状态
// 纯函数，可单测；不读写 DB，DB 侧调用方负责提供 ownerId/status。
// 设计依据：第四阶段报告 §4。
// ================================================================

import type { Actor, AssetRef, AssetAction, RiskLevel } from './types';
import { PROTECTED_TYPES, AUTO_EXPERIMENTABLE } from './types';

export type DenyReason =
  | 'protected_type' | 'not_owner' | 'cross_user' | 'actor_kind'
  | 'action_not_allowed' | 'risk_too_high' | 'state_not_allowed'
  | 'unregistered_asset' | 'missing_actor';

export interface CanResult {
  allow: boolean;
  reason?: DenyReason;
  detail?: string;
}

const ADMIN_ACTIONS: AssetAction[] = ['read', 'propose', 'approve', 'publish', 'pause', 'rollback', 'register', 'experiment', 'view_audit'];
const USER_ACTIONS: AssetAction[] = ['read', 'propose'];
const AGENT_ACTIONS: AssetAction[] = ['read', 'propose', 'experiment'];
const WORKER_ACTIONS: AssetAction[] = ['read', 'propose', 'experiment'];
const SERVICE_ACTIONS: AssetAction[] = ['read'];
const PLUGIN_ACTIONS: AssetAction[] = ['read'];
const SUBAGENT_ACTIONS: AssetAction[] = ['read'];

// 生命周期状态 → 允许的动作集合
const STATE_ACTIONS: Record<string, AssetAction[]> = {
  active: ['read', 'propose', 'experiment', 'publish', 'pause', 'rollback', 'register', 'approve', 'view_audit'],
  paused: ['read', 'approve', 'view_audit'],
  quarantined: ['read', 'approve', 'view_audit'],
  retired: ['read', 'view_audit'],
};

/**
 * 归一化：防大小写/不可见字符/前缀填充绕过。
 * 1) NFKC：全角字符折叠为半角（防 Ｓystem_Prompt 类）
 * 2) 删除 NUL、控制/零宽/BOM 字符（防 system\u0000prompt 类）
 * 3) 反复剥掉 './'、'../'、'/' 前缀
 * 4) 转小写
 */
export function normalizeAssetKey(assetKey: string): string {
  let k = String(assetKey ?? '');
  try { k = k.normalize('NFKC'); } catch { /* 环境不支持 NFKC 时按原样处理 */ }
  k = k.replace(/[\u0000-\u0020\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g, '');
  let prev = '';
  while (prev !== k) { prev = k; k = k.replace(/^(\.{1,2}\/|\/)+/, ''); }
  return k.trim().toLowerCase();
}

/** 规范化类型：只保留字母数字（防 system prompt / system_prompt / system\0prompt 等价绕过）。 */
export function normalizeAssetType(assetType: string): string {
  let t = String(assetType ?? '');
  try { t = t.normalize('NFKC'); } catch { /* 同上 */ }
  t = t.replace(/[\u0000-\u0020\u200b-\u200f\ufeff]/g, '');
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^_+/, '');
}

/** 只保留小写字母数字的键范式，用于前缀判等。 */
function canonicalKey(assetKey: string): string {
  return normalizeAssetKey(assetKey).replace(/[^a-z0-9]+/g, '');
}

/** 资产是否命中受保护黑名单（按归一化类型判，不受大小写/不可见字符影响）。 */
export function isProtectedType(assetType: string): boolean {
  const t = normalizeAssetType(assetType);
  return PROTECTED_TYPES.some((x) => normalizeAssetType(x) === t);
}

// assetKey 前缀兜底：即使 assetType 被误标，也按 key 结构拒绝。
const PROTECTED_KEY_PREFIXES: string[] = [
  'system_prompt', 'guardrail', 'auth', 'permission', 'tool', 'bash',
  'plugin', 'migration', 'secret', 'env', 'rsi_self', 'src', 'schema', 'prisma',
];

export function isProtectedAssetKey(assetKey: string): boolean {
  const k = normalizeAssetKey(assetKey);
  // 只校验首段：避免「tool_exec_error:...」这类合法键被 'tool' 前缀误伤，
  // 同时挡住 'tool:x'、'./src/x.js'、'. src/x.js' 等伪装。
  const first = (k.split(/[:/]/)[0] ?? '').replace(/[^a-z0-9]+/g, '');
  if (!first) return false;
  return PROTECTED_KEY_PREFIXES.some((p) => p.replace(/[^a-z0-9]+/g, '') === first);
}

/** 资产是否在自动实验白名单内。 */
export function isAutoExperimentable(assetType: string): boolean {
  const t = normalizeAssetType(assetType);
  return AUTO_EXPERIMENTABLE.some((x) => normalizeAssetType(x) === t);
}

export function can(
  actor: Actor,
  action: AssetAction,
  asset: AssetRef,
  riskLevel: RiskLevel = 'r0',
  assetStatus: string = 'active',
): CanResult {
  if (!actor || !actor.kind || !actor.id) {
    return { allow: false, reason: 'missing_actor', detail: '主体缺失' };
  }
  // 1) 黑名单优先：任何主体（含 admin）都不能写受保护类型。
  if (action !== 'read' && (isProtectedType(asset.assetType) || isProtectedAssetKey(asset.assetKey))) {
    return { allow: false, reason: 'protected_type', detail: `资产类型受保护: ${asset.assetType}` };
  }
  // 2) 生命周期状态门。
  const stateAllowed = STATE_ACTIONS[assetStatus];
  if (stateAllowed && !stateAllowed.includes(action)) {
    return { allow: false, reason: 'state_not_allowed', detail: `状态 ${assetStatus} 不允许 ${action}` };
  }
  const scope = asset.scope ?? (asset.ownerId ? 'user' : 'global');
  const isOwner = asset.ownerId ? actor.id === asset.ownerId : false;

  // 3) 跨用户：任何主体（含 admin 的写操作）不得写他人 user 域资产。
  if (scope === 'user' && asset.ownerId && !isOwner) {
    const readOnlyWrite = action === 'read' || action === 'approve' || action === 'view_audit';
    if (!readOnlyWrite) {
      return { allow: false, reason: 'cross_user', detail: `非资产所有者不得 ${action}` };
    }
  }
  // 4) 管理员整体放行（写他人资产仍受 3) 约束）。
  if (actor.kind === 'admin') {
    if (!ADMIN_ACTIONS.includes(action)) return { allow: false, reason: 'action_not_allowed' };
    return { allow: true };
  }
  // 5) 普通用户：仅本人资产的读与提议。
  if (actor.kind === 'user') {
    if (!USER_ACTIONS.includes(action)) return { allow: false, reason: 'action_not_allowed', detail: '普通用户不得执行该动作' };
    if (scope !== 'user') return { allow: false, reason: 'not_owner', detail: '普通用户不得写全局资产' };
    if (!isOwner && action !== 'read') return { allow: false, reason: 'not_owner', detail: '非资产所有者不得写' };
    return { allow: true };
  }
  // 6) Agent / Worker / Subagent：写动作（propose/experiment）只允许落在
  //    AUTO_EXPERIMENTABLE 白名单内，白名单外一律拒绝（默认拒绝，不是默认允许）。
  if (actor.kind === 'agent' || actor.kind === 'worker' || actor.kind === 'subagent') {
    const allowed = actor.kind === 'agent' ? AGENT_ACTIONS : actor.kind === 'worker' ? WORKER_ACTIONS : SUBAGENT_ACTIONS;
    if (!allowed.includes(action)) return { allow: false, reason: 'action_not_allowed' };
    if (action !== 'read' && !isAutoExperimentable(asset.assetType)) {
      return { allow: false, reason: 'not_experimentable', detail: `资产类型 ${asset.assetType} 不在自动实验白名单` };
    }
    if ((action === 'propose' || action === 'experiment') && riskLevel === 'r3') {
      return { allow: false, reason: 'risk_too_high', detail: 'r3 变更必须人工提议' };
    }
    return { allow: true };
  }
  // 7) Service / Plugin：只读。
  if (actor.kind === 'service' || actor.kind === 'plugin') {
    const allowed = actor.kind === 'service' ? SERVICE_ACTIONS : PLUGIN_ACTIONS;
    if (!allowed.includes(action)) return { allow: false, reason: 'actor_kind' };
    return { allow: true };
  }
  return { allow: false, reason: 'actor_kind', detail: `未知主体类型: ${actor.kind}` };
}
