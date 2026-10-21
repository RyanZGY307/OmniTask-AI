// ================================================================
// Token Usage Integration — the chat-path entry point.
//
//   provider usage → 真实 token → TokenUsage row → user view.
//
// **本模块不扣费。** 扣费的唯一入口是 services/credits.ts 的 deductCredits
// （→ finance/billingLedger.chargeCredits，带幂等键、账本与重试）。
// 曾经这里也做了一次 creditBalance 扣减（deductUserCredits），与上面那条
// 路径构成同一请求扣两次积分的双扣；该扣减已删除。
//
// 展示与扣费读同一组真实值。放大乘数、overflow 转移、防反推取整均已删除，
// 见 tokenBilling.ts 文件头。
// ================================================================

import { prismaUser, withRetry } from '../db';
import {
  calculateBilling,
  deductCredits,
  normalizeMode,
  type ChatMode,
  type BillingResult,
  type LimitSource,
} from './tokenBilling';
import { getVerifiedOutputLimit, getModelLimitRow } from './modelLimits';

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TokenUsageInput {
  userId: string;
  sessionId?: string;
  messageId?: string;
  modelKey: string;
  mode: string | ChatMode;
  providerUsage: ProviderUsage;
  /**
   * 必填。TokenUsage.provider 在 schema 里是无默认值的必填列，历史代码
   * 从未给它赋值，导致每次 create 都抛 "Argument provider is missing"，
   * 错误在 chat.ts 被 catch 成 warn 后继续 —— 于是这张表**一行都没写进去过**。
   */
  provider: string;
  /**
   * 本请求实际扣掉的积分数，由调用方（chat.ts，已扣费的那一处）传入。
   * 不传则按 tokenBilling 的公式自行换算。两者只应有一个来源，否则
   * 用户看到的值与真实扣费会不一致。
   */
  creditsUsed?: number;
  traceId?: string;
  requestId?: string;
}

export interface UserTokenView {
  tokenUsage: {
    displayInput: number;
    displayOutput: number;
    displayTotal: number;
  };
  creditsUsed: number;
}

// Assemble a TokenUsage row's data (actual + display + metadata).
export function buildUsageRecord(input: {
  userId: string;
  sessionId?: string;
  messageId?: string;
  model: string;
  /** 必填列，见 TokenUsageInput.provider 的说明。 */
  provider: string;
  modelVersion?: string | null;
  actualInput: number;
  actualOutput: number;
  billing: BillingResult;
  mode: ChatMode;
  multiplier: number;
  verifiedOutputLimit: number | null;
  limitSource: LimitSource;
  limitVerifiedAt?: string | null;
}) {
  const actualTotal = input.actualInput + input.actualOutput;
  return {
    userId: input.userId,
    sessionId: input.sessionId ?? null,
    messageId: input.messageId ?? null,
    provider: input.provider,
    actualInputTokens: input.actualInput,
    actualOutputTokens: input.actualOutput,
    actualTotalTokens: actualTotal,
    displayInputTokens: input.billing.displayInput,
    displayOutputTokens: input.billing.displayOutput,
    displayTotalTokens: input.billing.displayTotal,
    mode: input.mode,
    multiplier: input.multiplier,
    overflowTransferred: input.billing.overflowTransferred,
    overflowAmount: input.billing.overflowAmount,
    model: input.model,
    modelVersion: input.modelVersion ?? null,
    verifiedOutputLimit: input.verifiedOutputLimit,
    limitSource: input.limitSource,
    limitVerifiedAt: input.limitVerifiedAt ? new Date(input.limitVerifiedAt) : null,
  };
}


export async function processTokenUsage(input: TokenUsageInput): Promise<UserTokenView> {
  const mode = normalizeMode(input.mode);
  const actualInput = Math.max(0, Math.floor(input.providerUsage.inputTokens || 0));
  const actualOutput = Math.max(0, Math.floor(input.providerUsage.outputTokens || 0));

  // 1) Verified output limit (cache read only — never discover here).
  //    保留调用：limit 仍作为模型元数据记录，但**不再参与任何数值计算**。
  const verifiedOutputLimit = await getVerifiedOutputLimit(input.modelKey).catch(() => null);

  // 2) 唯一一次换算：真实 token → 计费口径（无放大、无转移、无取整）。
  const display = calculateBilling(actualInput, actualOutput, mode, verifiedOutputLimit);

  // 3) 倍率已废除，落库固定为 1；列保留以免动表结构。
  const multiplier = 1;

  // 4) Model limit provenance.
  const row = await getModelLimitRow(input.modelKey).catch(() => null);

  const usageData = buildUsageRecord({
    userId: input.userId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    model: input.modelKey,
    provider: input.provider,
    modelVersion: row?.version ?? null,
    actualInput,
    actualOutput,
    // display* 与实际值恒等，写同一个结果。
    billing: display,
    mode,
    multiplier,
    verifiedOutputLimit,
    limitSource: row?.source ?? 'unknown',
    limitVerifiedAt: row?.verifiedAt?.toISOString() ?? null,
  });

  // 5) 落库 TokenUsage。**不在这里扣费** —— 扣费已由 chat.ts 的
  //    deductCredits（→ chargeCredits，带幂等键与账本）单独完成。
  //    原先此处又一次 decrement creditBalance，构成双扣，已删除。
  //    creditsUsed 以调用方传入的实际扣费额为准；未传时才用公式换算，
  //    这样用户看到的积分消耗与实际扣费永远是同一个数。
  //    并发写可能撞上序列化冲突（P2034/40001/40P01），保留退避重试。
  const creditsUsed = input.creditsUsed ?? deductCredits(display, input.modelKey);
  await withRetry(() => prismaUser.tokenUsage.create({ data: usageData }), 3, 'tokenUsage.create');

  // 6) 用户视图：只给 token 与积分。字段名沿用 display*，
  //    值已与真实消耗一致。
  return {
    tokenUsage: {
      displayInput: display.displayInput,
      displayOutput: display.displayOutput,
      displayTotal: display.displayTotal,
    },
    creditsUsed,
  };
}
