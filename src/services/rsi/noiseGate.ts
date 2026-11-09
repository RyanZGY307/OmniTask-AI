// ================================================================
// NoiseGate — 纯函数噪声/冷却/并发控制。
// 状态由调用方（DB）提供，本模块只做判定，便于单测。
// ================================================================

export interface NoisePolicy {
  maxPerTypePer5Min: number;   // 同资产同型信号 5 分钟上限
  minSeverity: 'low' | 'medium' | 'high';
  cooldownMinutes: number;     // 同资产冷却期（分钟）
  maxOpenPerAsset: number;     // 同资产并发未闭环 ChangeRequest 上限
  maxDailyProposals: number;   // 每日全局候选上限（防刷）
}

export const DEFAULT_NOISE_POLICY: NoisePolicy = {
  maxPerTypePer5Min: 1,
  minSeverity: 'medium',
  cooldownMinutes: 30,
  maxOpenPerAsset: 1,
  maxDailyProposals: parseInt(process.env.RSI_MAX_DAILY_PROPOSALS || '20', 10) || 20,
};

export type SignalSeverity = 'low' | 'medium' | 'high';
const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

export function severityOk(sev: string, min: SignalSeverity): boolean {
  return (SEVERITY_RANK[sev] ?? 0) >= (SEVERITY_RANK[min] ?? 1);
}

/** 频率判定：过去 5 分钟同型信号数是否已达上限。 */
export function frequencyOk(recentSameType: number, policy: NoisePolicy): boolean {
  return recentSameType < policy.maxPerTypePer5Min;
}

/** 冷却判定：距上次同资产候选生成是否已过冷却期。 */
export function cooldownOk(lastProposalAt: Date | null, now: Date, policy: NoisePolicy): boolean {
  if (!lastProposalAt) return true;
  const elapsedMin = (now.getTime() - lastProposalAt.getTime()) / 60000;
  return elapsedMin >= policy.cooldownMinutes;
}

/** 并发上限判定。 */
export function concurrencyOk(openChangeCount: number, policy: NoisePolicy): boolean {
  return openChangeCount < policy.maxOpenPerAsset;
}

/** 每日预算判定。 */
export function dailyBudgetOk(todayCount: number, policy: NoisePolicy): boolean {
  return todayCount < policy.maxDailyProposals;
}

export interface NoiseVerdict {
  pass: boolean;
  failed: string[];
}

export function evaluateNoise(input: {
  severity: string;
  recentSameType: number;
  lastProposalAt: Date | null;
  openChangeCount: number;
  todayCount: number;
  now?: Date;
  policy?: NoisePolicy;
}): NoiseVerdict {
  const policy = input.policy ?? DEFAULT_NOISE_POLICY;
  const now = input.now ?? new Date();
  const failed: string[] = [];
  if (!severityOk(input.severity, policy.minSeverity)) failed.push('severity_below_min');
  if (!frequencyOk(input.recentSameType, policy)) failed.push('frequency_exceeded');
  if (!cooldownOk(input.lastProposalAt, now, policy)) failed.push('cooldown_active');
  if (!concurrencyOk(input.openChangeCount, policy)) failed.push('asset_concurrency_full');
  if (!dailyBudgetOk(input.todayCount, policy)) failed.push('daily_budget_exhausted');
  return { pass: failed.length === 0, failed };
}
