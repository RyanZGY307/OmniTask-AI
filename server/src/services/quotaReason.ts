// ================================================================
// 过闸失败原因分类：只有"数据额度限制"才允许触发自动切换。
//
// 用户口径（m02000 补充任务）：并发满 / 网络超时 / 一般 5xx / 401 /403 /
// 参数错误 / 模型能力不兼容 —— 一律不得触发自动切换。
// ================================================================

/** 允许触发切换的原因（数据额度类）。 */
export const QUOTA_SWITCHABLE = ['blocked', 'tpd_limit_rpm', 'rate_limited'] as const;

/** 明确禁止触发切换的原因（非数据额度类）。 */
export const NON_SWITCHABLE = [
  'max_parallel',        // 并发满 → 排队而非切换
  'timeout',             // 网络超时
  'http_5xx',            // 一般 5xx
  'auth_401',
  'auth_403',
  'bad_request',
  'capability_mismatch',
  'db_unavailable',
] as const;

export type SwitchableReason = typeof QUOTA_SWITCHABLE[number];
export type NonSwitchableReason = typeof NON_SWITCHABLE[number];

/** 是否允许因该原因自动切换 API/模型。 */
export function isQuotaSwitchable(reason: string | undefined | null): reason is SwitchableReason {
  if (!reason) return false;
  return (QUOTA_SWITCHABLE as readonly string[]).includes(reason);
}

/** 非数据额度类原因的稳定错误码（调用方据此决定排队还是抛错）。 */
export function nonSwitchableCode(reason: string | undefined | null): string {
  return reason || 'unknown_block';
}
