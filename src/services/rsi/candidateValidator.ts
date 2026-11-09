// ================================================================
// CandidateValidator — 纯代码校验：Schema / 白名单 / 红线 / 差异 / 引用。
// 全部纯函数；不调用模型，不读 DB（所需上下文由调用方注入）。
// ================================================================

import type { ProposalPayload } from './types';
import { isAutoExperimentable, isProtectedType } from './authorization';

export interface ValidationInput {
  proposal: ProposalPayload;
  currentInstruction?: string;         // 当前资产内容（用于差异审查）
  allowedAssetKeys?: string[];         // 资产白名单（代码管理，含通配前缀）
  maxContentLen?: number;
}

export type Violation =
  | 'schema' | 'blacklist' | 'redline' | 'not_whitelisted'
  | 'diff_empty' | 'diff_too_large' | 'no_hypothesis' | 'content_too_long';

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
  diffRatio: number;
}

const CONTENT_REDLINES: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /忽略(上述|以上|之前)(所有)?指令/,
  /system\s*prompt/i,
  /(?<!\w)(prompt:\s*you\s+are)(?!\w)/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /api[_-]?key\s*[:=]/i,
  /password\s*[:=]/i,
  /\b(email|passport|id[_-]?card|身份证|护照)\b.{0,20}\b(number|号)\b/i,
];

/** 内容红线：命中任一即拒绝（与资产类型无关）。 */
export function redline(text: string): boolean {
  return CONTENT_REDLINES.some((r) => r.test(text));
}

/** 差异率：与当前版本相比变化的字符比例（0..1）。 */
export function diffRatio(before: string, after: string): number {
  if (!before && !after) return 0;
  const max = Math.max(before.length, after.length);
  if (max === 0) return 0;
  let same = 0;
  const min = Math.min(before.length, after.length);
  for (let i = 0; i < min; i++) if (before[i] === after[i]) same++;
  return 1 - same / max;
}

export function validateCandidate(input: ValidationInput): ValidationResult {
  const violations: Violation[] = [];
  const p = input.proposal;
  const maxLen = input.maxContentLen ?? 20_000;

  // 1) Schema：必填字段与非空
  if (!p || typeof p.content !== 'string' || p.content.trim().length === 0) violations.push('schema');
  if (!p.assetType || !p.assetKey) violations.push('schema');
  if (!p.changeKind) violations.push('schema');
  if (!p.hypothesis || p.hypothesis.trim().length < 4) violations.push('no_hypothesis');
  if (p.content.length > maxLen) violations.push('content_too_long');

  // 2) 黑名单：受保护资产类型一律拒绝（名称再像也不放行）
  if (p.assetType && isProtectedType(p.assetType)) violations.push('blacklist');

  // 3) 自动实验白名单：不在名单内的资产不能自动实验
  if (p.assetType && !isAutoExperimentable(p.assetType)) violations.push('not_whitelisted');

  // 4) 内容红线
  if (p.content && redline(p.content)) violations.push('redline');

  // 5) 资产键白名单（代码管理，支持后缀通配）
  if (input.allowedAssetKeys && input.allowedAssetKeys.length > 0) {
    const okKey = input.allowedAssetKeys.some((k) => p.assetKey === k || p.assetKey.endsWith(k));
    if (!okKey) violations.push('not_whitelisted');
  }

  // 6) 差异审查
  if (input.currentInstruction !== undefined) {
    if (p.changeKind === 'modify' && p.content.trim() === input.currentInstruction.trim()) {
      violations.push('diff_empty');
    }
    const ratio = diffRatio(input.currentInstruction, p.content);
    if (ratio > 0.9) violations.push('diff_too_large');
  }

  return {
    ok: violations.length === 0,
    violations,
    diffRatio: input.currentInstruction !== undefined ? diffRatio(input.currentInstruction || '', p.content || '') : 0,
  };
}

/** 结构化 AI 输出的 Schema 校验（字段+枚举白名单），非法枚举视为降级而非崩溃。 */
export function parseProposalStrict(raw: unknown, allowedEnums: Record<string, string[]>): { ok: true; value: ProposalPayload } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'not_object' };
  const o = raw as Record<string, unknown>;
  for (const [k, allowedList] of Object.entries(allowedEnums)) {
    const v = o[k];
    if (v !== undefined && !allowedList.includes(String(v))) return { ok: false, reason: `bad_enum:${k}` };
  }
  const req = ['assetType', 'assetKey', 'content', 'hypothesis', 'changeKind'];
  for (const k of req) {
    if (typeof o[k] !== 'string' || (o[k] as string).length === 0) return { ok: false, reason: `missing:${k}` };
  }
  return {
    ok: true,
    value: {
      assetType: String(o.assetType),
      assetKey: String(o.assetKey),
      content: String(o.content),
      hypothesis: String(o.hypothesis),
      changeKind: String(o.changeKind),
      instructionDelta: typeof o.instructionDelta === 'string' ? o.instructionDelta : undefined,
    },
  };
}
