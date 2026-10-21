// ================================================================
// Token Billing — 单轨：展示与扣费一律用 provider 回传的真实 token
// ================================================================
// 【历史】本模块曾是「Actual / Display 双轨」：
//   ACTUAL  = provider 原始 usage，仅后端成本分析使用，永不展示。
//   DISPLAY = 按模式乘数把输出放大后的值（standard ×1.1、thinking ×1.2），
//             展示给用户并用于扣积分，超限部分还会从 output 转移到 input，
//             且再过一遍把显示值取整到 10/50 的「防反推」取整。
// 即用户在用量页看到的数字并不是自己消耗的 token。
//
// 该机制已整体移除。现在**只有一条轨道**：provider 回传多少就是多少，
// 展示、扣费、成本核算读同一个数。调用方拿到的 display* 字段与实际值
// 恒等，字段名保留只为不改动数据库列与既有查询。
//
// 移除的四种造假，逐条对应：
//   1. 模式乘数放大（MODE_MULTIPLIER / multiplierFor）— 删除。
//   2. 超限 overflow 从 output 转移到 input — 删除。
//   3. 防反推取整（deterministicRound / applyAntiReverseRounding）—
//      显示值不再等于真实消耗，删除。
//   4. provider 未回 usage 时按 70%/30% 伪造拆分（在 routes/chat.ts）—
//      改为「没有就不写」，不再编一个数字。
//
// 保留：
//   · calculateBilling 仍接受 mode/verifiedOutputLimit 参数，是为了不牵动
//     所有调用点的签名；这两个参数现在不再影响任何数值。
//   · overflowTransferred / overflowAmount 恒为 false/0，字段保留同因。
//   · TokenUsage 表里的 actual* 与 display* 列都仍在写，且写同一组真实值；
//     彻底删列需要一次迁移，本提交不动表结构（见提交说明的已知限制）。
//
// 所有函数都是纯函数：无随机、无 I/O、可确定性复现。
// ================================================================

import { MODEL_REGISTRY, type ModelRegistryEntry } from '../../config';
import { getDynamicModels } from '../configSync';

// 模式名仍是合法元数据（用于统计「哪种模式被用了多少次」），
// 但它**不再改变任何 token 数值**。
export type ChatMode = 'fast' | 'standard' | 'thinking';

// 未知/非法模式归为 fast。仅作归一化，不涉及放大。
export function normalizeMode(mode: string | undefined | null): ChatMode {
  if (mode === 'fast' || mode === 'standard' || mode === 'thinking') return mode;
  return 'fast';
}

export interface BillingResult {
  // 这三个字段与实际消耗恒等（见文件头说明，字段名保留是为不动 DB 列）。
  displayInput: number;
  displayOutput: number;
  displayTotal: number;
  overflowTransferred: boolean;
  overflowAmount: number;
}

/**
 * 把 provider 回传的真实 token 规整为计费口径。
 *
 * 只做两件事，且都与「不造假」有关：
 *   · 挡住负数 / NaN / 小数（Provider 偶发返回垃圾值）
 *   · 向下取整到整数 token
 *
 * mode 与 verifiedOutputLimit 不再影响结果：放大与转移逻辑已删除。
 */
export function calculateBilling(
  actualInput: number,
  actualOutput: number,
  _mode: ChatMode,
  _verifiedOutputLimit: number | null,
): BillingResult {
  const inp = Math.max(0, Math.floor(Number.isFinite(actualInput) ? actualInput : 0));
  const out = Math.max(0, Math.floor(Number.isFinite(actualOutput) ? actualOutput : 0));
  return {
    displayInput: inp,
    displayOutput: out,
    displayTotal: inp + out,
    overflowTransferred: false,
    overflowAmount: 0,
  };
}

/**
 * token → 积分。唯一的换算点。
 * 入参是**真实** token；本函数不再从任何放大后的中间值取值。
 */
export function deductCredits(result: BillingResult, modelKey: string): number {
  const modelInfo: ModelRegistryEntry | undefined =
    (getDynamicModels()[modelKey] as ModelRegistryEntry) ?? (MODEL_REGISTRY as Record<string, ModelRegistryEntry>)[modelKey];
  const costPer1k = modelInfo?.costPer1k ?? 0;
  if (costPer1k <= 0) return 0;
  return Math.ceil((result.displayTotal / 1000) * costPer1k);
}

// Record persisted to TokenUsage (see schema-user.prisma).
// actualTotal === displayTotal 恒成立（双轨已合并，见文件头）。
export interface TokenUsageRecord {
  actualInputTokens: number;
  actualOutputTokens: number;
  actualTotalTokens: number;

  // 以下四个字段为保留的历史列名，值与上一组相同。
  displayInputTokens: number;
  displayOutputTokens: number;
  displayTotalTokens: number;

  mode: ChatMode;
  multiplier: number;
  overflowTransferred: boolean;
  overflowAmount: number;

  model: string;
  modelVersion?: string | null;
  verifiedOutputLimit: number | null;
  limitSource?: 'provider_api' | 'official_sdk' | 'official_docs' | 'unknown';
  limitVerifiedAt?: string | null;
}

export type LimitSource = 'provider_api' | 'official_sdk' | 'official_docs' | 'unknown';
