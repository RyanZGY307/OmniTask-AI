// ================================================================
// 额度字段统一解析规则（前后端共用同一套语义）。
//
// 约定（admin UI 与 API 一致）：
//   '-' 或留空（空串 / null / undefined / 纯空白） → null = 无限制
//   非负整数                                    → 生效额度
//   其他任何值（负数 / 小数 / 'abc' / '12x' / NaN）→ 抛 invalid_limit
//
// 为什么必须抛错而不是当成无限：历史缺陷是 norm() 里 Number('abc')=NaN
// 被当成 0=无限，等于把脏配置静默升级成"不设防"。
// ================================================================

export class InvalidLimitError extends Error {
  constructor(public field: string, public value: unknown) {
    super(`额度字段 ${field} 的值无效: ${JSON.stringify(value)}（只接受非负整数、'-' 或留空）`);
    this.name = 'InvalidLimitError';
  }
}

/** 单字段解析：null=无限制，number=生效额度，其他抛 InvalidLimitError。 */
export function parseLimitValue(field: string, raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new InvalidLimitError(field, raw);
    if (!Number.isInteger(raw)) throw new InvalidLimitError(field, raw);
    if (raw < 0) throw new InvalidLimitError(field, raw);
    return raw === 0 ? null : raw; // 0 兼容历史语义 = 无限制
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '' || t === '-') return null;
    if (!/^\d+$/.test(t)) throw new InvalidLimitError(field, raw);
    const n = Number(t);
    if (!Number.isSafeInteger(n)) throw new InvalidLimitError(field, raw);
    return n === 0 ? null : n;
  }
  throw new InvalidLimitError(field, raw);
}

/** 限速行为字段：缺省 block；只接受 block / limitRpm。 */
export function parseTpdBehavior(raw: unknown): 'block' | 'limitRpm' {
  if (raw === undefined || raw === null || raw === '') return 'block';
  if (raw === 'block' || raw === 'limitRpm') return raw;
  throw new InvalidLimitError('tpdBehavior', raw);
}

export interface RateLimitFields {
  rpm?: unknown; tpm?: unknown; rpd?: unknown; maxParallel?: unknown; tpd?: unknown;
  tpdBehavior?: unknown; tpdLimitRpm?: unknown;
}

export interface ParsedRateLimitBlock {
  rpm: number | null;
  tpm: number | null;
  rpd: number | null;
  maxParallel: number | null;
  tpd: number | null;
  tpdBehavior: 'block' | 'limitRpm';
  tpdLimitRpm: number | null;
}

const FIELDS: Array<keyof RateLimitFields> = ['rpm', 'tpm', 'rpd', 'maxParallel', 'tpd', 'tpdLimitRpm'];

/**
 * 解析整块额度配置（保存前 / 载入后各跑一次，双保险）。
 * raw 可以是 JSON 字符串、对象或 null；非法字段立即抛错，绝不被静默吞掉。
 */
export function parseRateLimitBlock(raw: unknown): ParsedRateLimitBlock {
  let obj: Record<string, unknown> = {};
  if (raw === undefined || raw === null || raw === '') return emptyBlock();
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '' || t === '-') return emptyBlock();
    try { obj = JSON.parse(t) as Record<string, unknown>; }
    catch { throw new InvalidLimitError('limitBlock', raw); }
    if (obj === null || typeof obj !== 'object') throw new InvalidLimitError('limitBlock', raw);
  } else if (typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  } else {
    throw new InvalidLimitError('limitBlock', raw);
  }

  const out: Record<string, number | null> = {};
  for (const f of FIELDS) out[f] = parseLimitValue(f, obj[f]);
  return {
    rpm: out.rpm!, tpm: out.tpm!, rpd: out.rpd!, maxParallel: out.maxParallel!, tpd: out.tpd!,
    tpdBehavior: parseTpdBehavior(obj.tpdBehavior),
    tpdLimitRpm: out.tpdLimitRpm!,
  };
}

export function emptyBlock(): ParsedRateLimitBlock {
  return { rpm: null, tpm: null, rpd: null, maxParallel: null, tpd: null, tpdBehavior: 'block', tpdLimitRpm: null };
}

/** 整块是否"完全无限制"（前端用：全空则不发该字段）。 */
export function isUnlimitedBlock(b: ParsedRateLimitBlock): boolean {
  return b.rpm === null && b.tpm === null && b.rpd === null && b.maxParallel === null && b.tpd === null && b.tpdLimitRpm === null;
}
