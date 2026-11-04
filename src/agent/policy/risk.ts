// 风险定级（tool-contracts §7.1/§7.2 + security §9.1 的代码落地）
// 规则：工具自报档为下限；参数级复核可升不可降；取较高者（security §9.1 末句）。
// neverAuto 能力集（r3）：凭据访问/删除越界/改 Agent 或扩展配置/远程连接/外发类。
import { resolveArgPath, type ToolSpec } from '../tools/registry';

export type RiskLevel = 'r0' | 'r1' | 'r2' | 'r3';

/** neverAuto 能力集标签（ToolSpec.capabilityTags） */
export const NEVER_AUTO_CAPABILITIES = ['credential_access', 'config_mutation', 'remote_connect', 'data_exfil', 'delete_out_of_scope'] as const;

export interface RiskDecision {
  level: RiskLevel;
  reasons: string[];               // 升档原因（可审计）
  toolDeclared: RiskLevel;
}

export function isNeverAuto(spec: ToolSpec): boolean {
  return (spec.capabilityTags ?? []).some((t) => (NEVER_AUTO_CAPABILITIES as readonly string[]).includes(t));
}

/** 参数级复核：路径逃逸/删除越界/外发 URL 等信号 → 升档 */
export function assessRisk(spec: ToolSpec, args: Record<string, unknown>): RiskDecision {
  const declared = spec.riskLevel;
  let level = declared;
  const reasons: string[] = [];
  const bump = (to: RiskLevel, why: string) => {
    if (rank(to) > rank(level)) { level = to; reasons.push(why); }
  };
  if (isNeverAuto(spec)) bump('r3', `neverAuto 能力集: ${(spec.capabilityTags ?? []).join(',')}`);
  // 路径规范化：绝对路径 / 工作区外 / 穿越
  if (typeof args.path === 'string') {
    const raw = resolveArgPath(args.path, spec.workspaceRoots ?? []);
    if (raw.includes('..')) bump('r1', '路径含 ..（穿越嫌疑，按原始串判定）');
    const p = normalizePath(raw);
    if (!isInsideWorkspace(p, spec)) bump('r2', '目标位于工作区白名单外');
  }
  if (spec.sideEffects === 'non_idempotent' || spec.sideEffects === 'external') bump(rank(level) >= rank('r2') ? 'r3' : 'r2', `副作用类型 ${spec.sideEffects}：不可自动重试`);
  return { level, reasons, toolDeclared: declared };
}

function rank(r: RiskLevel): number {
  return r === 'r0' ? 0 : r === 'r1' ? 1 : r === 'r2' ? 2 : 3;
}

/** 路径规范化：去冗余段（不触盘，纯字符串；防 ../ 穿越误判由白名单兜底） */
export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return '/' + parts.join('/');
}

/**
 * 工作区白名单校验（M1：策略函数式，根目录由运行时注入 spec.workspaceRoots）。
 * 宿主侧 WorkspacePath 根定义待确认（Q5 旧项）→ 白名单为空时保守拒绝一切路径（宁可拒绝不可越界）。
 */
export function isInsideWorkspace(normalized: string, spec: ToolSpec): boolean {
  const roots = spec.workspaceRoots ?? [];
  if (roots.length === 0) return false;
  return roots.some((r) => normalized === r || normalized.startsWith(r.endsWith('/') ? r : r + '/'));
}
