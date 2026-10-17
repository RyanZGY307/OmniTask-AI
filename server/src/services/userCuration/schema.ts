// ================================================================
// Curation Output Schema — 模型输出的结构定义与验证（与系统提示词分离）
// ================================================================
// 整理 AI 只负责"分析与提议"；本层是后端对提议的结构与业务规则验证。
// 任何不在白名单内的 category/scope/operation 一律拒绝执行。
// ================================================================

import { parseWorkerJson } from '../scenarioWorkers/agnesCaller';

export const ALLOWED_CATEGORIES = [
  'USER_PREFERENCE',
  'DOMAIN_KNOWLEDGE',
  'PROJECT',
  'SESSION',
  'TASK',
  'ARTIFACT',
  'EXPERIENCE',
  'TEMPORARY',
] as const;

export const ALLOWED_SCOPES = [
  'USER',
  'DOMAIN',
  'PROJECT',
  'SESSION',
  'TASK',
  'ARTIFACT',
  'TEMPORARY',
] as const;

export const ALLOWED_OPERATIONS = [
  'ADD',
  'UPDATE',
  'MERGE',
  'LINK',
  'ARCHIVE',
  'DELETE',
  'NOOP',
  'REVIEW',
] as const;

export const ALLOWED_EVIDENCE = ['explicit', 'observed', 'inferred', 'unverified'] as const;

export type Category = (typeof ALLOWED_CATEGORIES)[number];
export type Scope = (typeof ALLOWED_SCOPES)[number];
export type Operation = (typeof ALLOWED_OPERATIONS)[number];
export type EvidenceType = (typeof ALLOWED_EVIDENCE)[number];

export interface CurationCandidate {
  category: Category;
  scope: Scope;
  operation: Operation;
  /** 便于定位同类记录的业务键，如 "response.language"、"project:omnitask/stack" */
  key: string;
  /** 结构化内容。content 字段为必需的自然语言正文；domain/project 视 scope 而定 */
  value: {
    content: string;
    domain?: string;
    project?: string;
    attributes?: Record<string, unknown>;
  };
  confidence: number;  // 0..1，仅为模型自评的启发式参考
  importance: number;  // 0..1
  evidence_type: EvidenceType;
  reason: string;
  /** UPDATE/MERGE/ARCHIVE/DELETE 必须引用既有记录的真实 id */
  target_id?: string;
}

export interface CurationOutput {
  candidates: CurationCandidate[];
}

export interface ValidationError {
  index: number;
  field: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  output?: CurationOutput;
  errors: ValidationError[];
}

function clamp01(n: unknown, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(1, v));
}

/** 明文秘密指纹：内容包含这些特征时，后端强制执行拒绝（不信任模型的自评） */
const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password\s*[:=]/i,
  /passwd\s*[:=]/i,
  /token\s*[:=]/i,
  /BEGIN [A-Z ]*PRIVATE KEY/i,
  /bearer\s+[a-z0-9\-._=]{12,}/i,
  /sk-[a-z0-9]{16,}/i,
  /rnd_[a-z0-9]{10,}/i,
  /vcp_[a-z0-9]{10,}/i,
  /ghp_[a-z0-9]{16,}/i,
  /xox[bapors]-[a-z0-9-]{10,}/i,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

/**
 * 解析并验证模型输出。无效 JSON / 非白名单值 / 缺失必需字段 → ok:false，
 * 调用方据此把任务标记为 failed（而不是盲目执行）。
 */
export function parseCurationOutput(raw: string): ValidationResult {
  const errors: ValidationError[] = [];
  const parsed = parseWorkerJson(raw, {
    category: ALLOWED_CATEGORIES as unknown as string[],
    scope: ALLOWED_SCOPES as unknown as string[],
    operation: ALLOWED_OPERATIONS as unknown as string[],
    evidence_type: ALLOWED_EVIDENCE as unknown as string[],
  }) as any;

  if (!parsed) {
    return { ok: false, errors: [{ index: -1, field: '<root>', message: 'not valid JSON or illegal enum value' }] };
  }

  const candidates: unknown[] = Array.isArray(parsed.candidates) ? parsed.candidates : null;
  if (!candidates) {
    return { ok: false, errors: [{ index: -1, field: 'candidates', message: 'candidates must be an array' }] };
  }
  if (candidates.length > 20) {
    return { ok: false, errors: [{ index: -1, field: 'candidates', message: 'too many candidates' }] };
  }

  const sanitized: CurationCandidate[] = [];
  (candidates as any[]).forEach((c, i) => {
    const base = { index: i } as any;
    if (!c || typeof c !== 'object') { errors.push({ ...base, field: 'candidate', message: 'not object' }); return; }
    const category = c.category;
    const scope = c.scope;
    const operation = c.operation;
    if (!ALLOWED_CATEGORIES.includes(category)) { errors.push({ ...base, field: 'category', message: `illegal category ${category}` }); return; }
    if (!ALLOWED_SCOPES.includes(scope)) { errors.push({ ...base, field: 'scope', message: `illegal scope ${scope}` }); return; }
    if (!ALLOWED_OPERATIONS.includes(operation)) { errors.push({ ...base, field: 'operation', message: `illegal operation ${operation}` }); return; }
    if (typeof c.key !== 'string' || !c.key.trim()) { errors.push({ ...base, field: 'key', message: 'key required' }); return; }
    if (!c.value || typeof c.value !== 'object') { errors.push({ ...base, field: 'value', message: 'value must be object' }); return; }
    if (typeof c.value.content !== 'string' || !c.value.content.trim()) { errors.push({ ...base, field: 'value.content', message: 'content required' }); return; }
    if (c.value.content.length > 2000) { errors.push({ ...base, field: 'value.content', message: 'content too long' }); return; }
    if (c.evidence_type !== undefined && !ALLOWED_EVIDENCE.includes(c.evidence_type)) { errors.push({ ...base, field: 'evidence_type', message: `illegal evidence_type` }); return; }
    if (['UPDATE', 'MERGE', 'ARCHIVE', 'DELETE', 'LINK'].includes(operation) && (!c.target_id || typeof c.target_id !== 'string')) {
      errors.push({ ...base, field: 'target_id', message: `${operation} requires target_id` });
      return;
    }
    if (operation === 'DELETE' && c.evidence_type !== 'explicit') {
      errors.push({ ...base, field: 'evidence_type', message: 'DELETE requires explicit evidence' });
      return;
    }
    if (looksLikeSecret(c.value.content)) { errors.push({ ...base, field: 'value.content', message: 'rejected: looks like a secret' }); return; }

    sanitized.push({
      category,
      scope,
      operation,
      key: String(c.key).slice(0, 200),
      value: {
        content: String(c.value.content).slice(0, 2000),
        ...(typeof c.value.domain === 'string' && c.value.domain ? { domain: c.value.domain.slice(0, 100) } : {}),
        ...(typeof c.value.project === 'string' && c.value.project ? { project: c.value.project.slice(0, 100) } : {}),
        ...(c.value.attributes && typeof c.value.attributes === 'object' ? { attributes: c.value.attributes } : {}),
      },
      confidence: clamp01(c.confidence, 0.5),
      importance: clamp01(c.importance, 0.4),
      evidence_type: (c.evidence_type as EvidenceType) || 'inferred',
      reason: typeof c.reason === 'string' ? c.reason.slice(0, 500) : '',
      ...(c.target_id ? { target_id: String(c.target_id) } : {}),
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, output: { candidates: sanitized }, errors: [] };
}
