// ================================================================
// 观测中心 — 纯逻辑层（无 db import，可在无数据库环境单测）
// ================================================================
// 本文件刻意不 import prisma/db：所有口径换算、脱敏、过期判定、分类
// 推断都在这里做纯函数实现，使它们可被 test/observability.test.ts
// 在完全没有 PostgreSQL 的环境下验证。
//
// 边界：本模块只做「算」与「判」，不做 IO。IO 在 collector.ts / purge.ts。

export const RETENTION_HOURS = 24;

// ---- 单位与口径（页面必须展示的口径说明） ----
export const SIZE_BASIS = {
  logical: 'pg_database_size(current_database())：该数据库自身逻辑占用',
  instanceUsed: '所属 PostgreSQL 实例磁盘已用量，同实例多库只统计一次',
  instanceTotal: '实例磁盘总容量；仅在托管平台提供可靠指标时非空',
  table: 'pg_relation_size：表自身数据，不含索引与 TOAST',
  index: 'pg_indexes_size：该表全部索引',
  toast: 'pg_total_relation_size - pg_relation_size - pg_indexes_size 差额法',
};

// ==================== 脱敏 ====================
// 命中的规则名写入 redactionApplied，供审计与页面展示。
const REDACT_RULES: { name: string; re: RegExp }[] = [
  { name: 'connection_string', re: /(postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|https?):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi },
  { name: 'url_userinfo', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@[^\s]+/gi },
  { name: 'secret_kv', re: /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|bearer|access[_-]?key|private[_-]?key)\b\s*["']?\s*[:=]\s*["']?[^\s"',;}]+/gi },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g },
];

export interface RedactResult {
  text: string;
  applied: string[];
}

export function redact(input: unknown): RedactResult {
  if (input === null || input === undefined) return { text: '', applied: [] };
  const applied: string[] = [];
  let text = typeof input === 'string' ? input : safeJson(input);
  for (const rule of REDACT_RULES) {
    // 每条规则独立判断是否命中，避免重复填同一个名字
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) {
      if (!applied.includes(rule.name)) applied.push(rule.name);
      text = text.replace(rule.re, `[REDACTED:${rule.name}]`);
    }
    rule.re.lastIndex = 0;
  }
  return { text, applied };
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ==================== 过期判定 ====================
export function computeExpiresAt(createdAt: Date | string): Date {
  const d = createdAt instanceof Date ? new Date(createdAt.getTime()) : new Date(createdAt);
  if (Number.isNaN(d.getTime())) throw new Error('createdAt 不是合法时间');
  return new Date(d.getTime() + RETENTION_HOURS * 60 * 60 * 1000);
}

/** 到期判定：等于 24h 即视为已过期（严格超过才有效）。 */
export function isExpired(expiresAt: Date | string, now: Date = new Date()): boolean {
  const e = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  const n = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(e.getTime())) return true;
  return e.getTime() <= n.getTime();
}

export function remainingSeconds(expiresAt: Date | string, now: Date = new Date()): number {
  const e = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return Math.max(0, Math.floor((e.getTime() - now.getTime()) / 1000));
}

/** 查询层强制过期过滤：所有读 AiRunSummary 的 SQL 必须带此谓词。 */
export const ACTIVE_SUMMARY_FILTER = { expiresAt: { gt: new Date() } };

// ==================== 口径换算 ====================
// TOAST 用差额法：total - table - index。差额不可能为负（浮点/统计延迟时
// 可能微负），夹到 0。三者互不重叠，可安全求和。
export function splitRelationSizes(total: number, table: number, index: number) {
  return {
    tableBytes: Math.max(0, Math.trunc(table)),
    indexBytes: Math.max(0, Math.trunc(index)),
    toastBytes: Math.max(0, Math.trunc(total - table - index)),
  };
}

/** 使用率：缺少可靠容量时必须返回 null，绝不能用 sizeBytes 顶替。 */
export function utilizationPercent(usedBytes: number | null | undefined, totalBytes: number | null | undefined): number | null {
  if (usedBytes === null || usedBytes === undefined) return null;
  if (totalBytes === null || totalBytes === undefined || totalBytes <= 0) return null;
  return Math.round((usedBytes / totalBytes) * 10000) / 100;
}

/**
 * 同实例去重：多个业务库共享一个 PG 实例时，实例级用量/容量只能算一次。
 * 多库各自报 sizeBytes（逻辑占用可相加），实例指标按 instanceId 聚合取一次。
 */
export function aggregateInstances(rows: {
  instanceId: string | null;
  sizeBytes: number;
  instanceDiskUsedBytes?: number | null;
  instanceDiskTotalBytes?: number | null;
  instanceDiskAvailableBytes?: number | null;
}[]): {
  totalLogicalBytes: number;
  instances: { instanceId: string; usedBytes: number | null; totalBytes: number | null; availableBytes: number | null }[];
} {
  let totalLogicalBytes = 0;
  const map = new Map<string, { instanceId: string; usedBytes: number | null; totalBytes: number | null; availableBytes: number | null }>();
  for (const r of rows) {
    totalLogicalBytes += Math.max(0, Math.trunc(r.sizeBytes || 0));
    const key = r.instanceId ?? '__unknown__';
    const cur = map.get(key) ?? { instanceId: key, usedBytes: null, totalBytes: null, availableBytes: null };
    // 同实例重复上报时取最大值，避免把同一实例的两份上报相加
    if (r.instanceDiskUsedBytes !== null && r.instanceDiskUsedBytes !== undefined) {
      cur.usedBytes = cur.usedBytes === null ? r.instanceDiskUsedBytes : Math.max(cur.usedBytes, r.instanceDiskUsedBytes);
    }
    if (r.instanceDiskTotalBytes !== null && r.instanceDiskTotalBytes !== undefined) {
      cur.totalBytes = cur.totalBytes === null ? r.instanceDiskTotalBytes : Math.max(cur.totalBytes, r.instanceDiskTotalBytes);
    }
    if (r.instanceDiskAvailableBytes !== null && r.instanceDiskAvailableBytes !== undefined) {
      cur.availableBytes = cur.availableBytes === null ? r.instanceDiskAvailableBytes : Math.max(cur.availableBytes, r.instanceDiskAvailableBytes);
    }
    map.set(key, cur);
  }
  return { totalLogicalBytes, instances: [...map.values()] };
}

// ==================== 业务分类推断 ====================
// 规则来自真实命名与代码领域（schema-user.prisma 实际模型名）。
// **没有证据就归 unclassified**，绝不猜一个类别来掩盖未知。
export interface CategoryRule { category: string; confidence: 'high' | 'medium'; tablePrefixes: string[]; evidence: string }
const DOMAIN_RULES: CategoryRule[] = [
  {
    category: '用户数据',
    confidence: 'high',
    tablePrefixes: ['User', 'UserSetting', 'UserProfile', 'UserPreference', 'UserRequirement', 'UserHabit', 'UserInterest', 'UserInstalledSkill', 'DeviceSession', 'BrowserSession', 'ActiveTaskState', 'AdminInvite', 'RegionInsight'],
    evidence: '表名前缀命中用户/设备领域映射',
  },
  {
    category: '对话数据',
    confidence: 'high',
    tablePrefixes: ['Message', 'Conversation', 'RequestTrace', 'ModelCall', 'ToolCall', 'Event', 'MemoryEntry', 'ContextMemory', 'FactMemory', 'ContextCompressionJob', 'Feedback', 'CorrectionEvent'],
    evidence: '表名前缀命中对话/链路追踪领域映射',
  },
  {
    category: '知识数据',
    confidence: 'high',
    tablePrefixes: ['Knowledge', 'Object', 'Variant', 'Fact', 'FactMemory', 'KnowledgeFolder', 'KnowledgeBase', 'DocumentChunk', 'DiscoveredModel', 'ModelPriceHistory'],
    evidence: '表名前缀命中知识/对象领域映射',
  },
  {
    category: '任务与自演化',
    confidence: 'high',
    tablePrefixes: ['ResearchJob', 'OrganizationJob', 'EvolutionJob', 'EvolutionSignal', 'EvolutionCandidate', 'EvolutionAudit', 'EvolutionBudget', 'RefreshTask', 'SelfRepairTask', 'SkillAnalysisJob', 'VerificationJob', 'ModelProfileJob', 'CurationJob', 'ResearchQueueState', 'KnowledgeBlindSpot'],
    evidence: '表名前缀命中任务编排/进化引擎领域映射',
  },
  {
    category: '计费与金融',
    confidence: 'high',
    tablePrefixes: ['Credit', 'Payment', 'Billing', 'TokenUsage', 'ModelUsage', 'Refund', 'Fx', 'Subscription', 'CreditPack', 'Pricing', 'ProviderPricing', 'CreditPricing', 'PricingVersion', 'ExchangeRate', 'Payment'],
    evidence: '表名前缀命中计费/支付领域映射',
  },
  {
    category: '系统与配置',
    confidence: 'medium',
    tablePrefixes: ['KeyValueCache', 'Setting', 'Config', 'PlatformManifest', 'ProviderHealth', 'ModelLimit', 'ModelConfig', 'ModelQuota', 'Prompt'],
    evidence: '表名前缀命中系统配置领域映射（中等置信度）',
  },
  {
    category: '观测中心',
    confidence: 'high',
    tablePrefixes: ['DbMetricSnapshot', 'DbStorageEntry', 'AiRunSummary', 'ObsEvent', 'SummaryPurgeLog', 'LogEntry', 'ErrorLog'],
    evidence: '本功能自身创建的表',
  },
  {
    category: '文件与工作台',
    confidence: 'medium',
    tablePrefixes: ['File', 'Workspace', 'OfficeArtifact', 'AudioArtifact', 'VoiceReference', 'Expression', 'EmojiSemantic', 'DialectOccurrence', 'ContextPattern'],
    evidence: '表名前缀命中文件/表达画像领域映射（中等置信度）',
  },
];

export function classifyTable(
  schemaName: string,
  tableName: string,
): { category: string; confidence: string; evidence: string } {
  for (const rule of DOMAIN_RULES) {
    for (const p of rule.tablePrefixes) {
      if (tableName === p || tableName.startsWith(p)) {
        return { category: rule.category, confidence: rule.confidence, evidence: rule.evidence };
      }
    }
  }
  return {
    category: 'unclassified',
    confidence: 'unknown',
    evidence: '无命名/代码证据可归属，标记待识别',
  };
}

// ==================== 批量删除计划 ====================
/** 计划分批：n 行、batch 大小 → 实际批次数（含不完整的尾批）。 */
export function planPurgeBatches(total: number, batchSize: number): number {
  if (total <= 0) return 0;
  const b = Math.max(1, Math.trunc(batchSize));
  return Math.ceil(total / b);
}

/** 清理延迟 = 实际删除时刻 - 到期时刻。负值不应出现（到期才删）。 */
export function purgeLatencyMs(deletedAt: Date, expiresAt: Date): number {
  return Math.max(0, deletedAt.getTime() - expiresAt.getTime());
}

// ==================== 分页/参数校验 ====================
export function parseIsoOrNull(v: unknown): Date | null {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// ==================== 陈旧度 ====================
export function staleness(lastCapturedAt: Date | string | null, now: Date = new Date()): {
  ageSeconds: number | null; stale: boolean;
} {
  if (!lastCapturedAt) return { ageSeconds: null, stale: true };
  const d = lastCapturedAt instanceof Date ? lastCapturedAt : new Date(lastCapturedAt);
  if (Number.isNaN(d.getTime())) return { ageSeconds: null, stale: true };
  const age = Math.floor((now.getTime() - d.getTime()) / 1000);
  return { ageSeconds: Math.max(0, age), stale: age > 900 };
}

// ==================== 原始 SQL（只读，勿改口径） ====================
export const PG_DB_SIZE_SQL = `SELECT pg_database_size(current_database()) AS size_bytes`;

export const PG_SCHEMA_TABLE_COUNT_SQL = `
  SELECT
    (SELECT count(*) FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema') AS schema_count,
    (SELECT count(*) FROM pg_stat_user_tables) AS table_count`;

export const PG_STORAGE_BREAKDOWN_SQL = `
  SELECT n.nspname AS schema_name,
         c.relname  AS table_name,
         pg_relation_size(c.oid)  AS table_bytes,
         pg_indexes_size(c.oid)   AS index_bytes,
         GREATEST(pg_total_relation_size(c.oid)
                  - pg_relation_size(c.oid)
                  - pg_indexes_size(c.oid), 0) AS toast_bytes,
         s.n_live_tup AS row_estimate
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE c.relkind IN ('r','m','p')
    AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname NOT LIKE 'pg_toast%'
    AND n.nspname NOT LIKE 'pg_temp%'
  ORDER BY pg_total_relation_size(c.oid) DESC
  LIMIT 500`;

/** 清理：每次最多取这么多过期行 id（分批删除，避免长事务）。 */
export const PG_ADVISORY_LOCK_SQL = `SELECT pg_try_advisory_lock($1::bigint) AS acquired`;
export const PG_ADVISORY_UNLOCK_SQL = `SELECT pg_advisory_unlock($1::bigint) AS released`;

// ==================== BigInt / JSON 安全换算 ====================
// Prisma 对 BigInt 列返回 BigInt，直接 JSON.stringify 会抛 TypeError。
// 容量值在安全整数范围内转 Number；超出则保留字符串并标记，避免静默失真。
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;
export function toJsonNumber(v: unknown): number | string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    if (v <= BigInt(MAX_SAFE)) return Number(v);
    return v.toString();
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 递归把对象里的 bigint 全部换成可 JSON 序列化的值。 */
export function jsonSafe<T>(v: T): T {
  if (v === null || v === undefined) return v;
  if (typeof v === 'bigint') return (toJsonNumber(v) as unknown) as T;
  if (Array.isArray(v)) return v.map((x) => jsonSafe(x)) as unknown as T;
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = jsonSafe(val);
    return out as unknown as T;
  }
  return v;
}
