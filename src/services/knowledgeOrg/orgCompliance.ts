// ================================================================
// KnowledgeOrg — 合规与确定性整理（旧「数据库自整理系统」能力合并至此）
// ================================================================
// 背景：旧系统 = services/knowledgeOrganizer.ts（355 行，Gemini 直调 +
// 确定性回退，一次一个 ResearchRecord）。新代系统 = services/knowledgeOrg/
// （快照 → 扫描 → worker → 合并 → 校验 → 落库，OrganizationJob 驱动）。
//
// 新代基础设施更完整，但旧系统有 7 项能力是新的**完全没有**的，全部移植到
// 本文件（**纯函数，无 IO、无 Prisma**，因此可在无库环境完整单测）：
//
//   1. VALID_CLAIM_TYPES  claim 类型白名单（不认识的类型 → 'UNKNOWN'，
//      绝不把非法值写进库）
//   2. clampConfidence     置信度夹到 [0,1]，越界/NaN → 0.5，
//      杜绝 AI 返回 confidence: 7 这类值
//   3. evidenceIds 幻觉防护  AI 编造的 evidenceId 一律丢弃
//      （只保留确实出现在本次输入里的 id）——这是防幻觉的核心闸门
//   4. variantId 白名单    同理，不存在的 variantId 一律丢弃
//   5. RELATION_TYPES      关系类型白名单，未知 → 'RELATED_TO'
//   6. deriveSourceType /
//      sourceTypeToClaimType  证据来源域 → claim 类型的确定性映射
//      （官方站=OFFICIAL_FACT、跑分站=MEASURED_RESULT、论坛/社交=USER_REPORT…）
//   7. firstSentence       claim 归一化到首句 + 300 字上限
//   8. FALLBACK_CONFIDENCE  各 claim 类型的确定性置信度兜底值
//   9. MAX_* 上限            facts/relations/categories/unknowns 的硬上限，
//      防 AI 一次返回海量条目
//
// 旧入口 organizeKnowledge(researchRecordId, ...) 仍保留但标记为 deprecated：
// 新代入口是 orgRuntime.executeOrganizationJob()。本文件被新代的
// orgValidator（写前校验）与 orgApplier（落库）调用，
// 因此**同一套合规规则同时覆盖新旧两条路径**，不存在「旧路径放宽」的漏洞。
// ================================================================

// 注意：这里**不能** `import { VALID_CLAIM_TYPES } from '../knowledgeValidator'`。
// 该文件顶部 import 了 prismaKnowledge（→ Prisma 引擎），一旦引用就毁掉本模块
// 的「纯函数、无 IO、可在无库环境完整单测」性质（实测：导入即抛
// EM_X86_64/EM_AARCH64 引擎不兼容）。因此白名单在此**自持**，
// knowledgeValidator.ts 改为从本文件再导出，保证单一来源且不反向依赖。
export const VALID_CLAIM_TYPES = [
  'OFFICIAL_FACT', 'MEASURED_RESULT', 'TECHNICAL_ANALYSIS', 'VISUAL_OBSERVATION',
  'USER_REPORT', 'OPINION', 'INFERENCE', 'UNKNOWN',
] as const;

// ---- 上限（与旧系统逐值一致，改这里就是改产品规则） ----
export const ORG_LIMITS = {
  MAX_FACTS: 50,
  MAX_RELATIONS: 20,
  MAX_CATEGORIES: 10,
  MAX_UNKNOWNS: 20,
  EVIDENCE_CONTENT_LIMIT: 2000,
} as const;

/** 关系类型白名单。未知类型一律降级为 RELATED_TO（而不是报错丢弃整条）。 */
export const RELATION_TYPES = [
  'RELATED_TO', 'COMPARED_WITH', 'PART_OF', 'AFFECTS',
  'REPLACED_BY', 'SIMILAR_TO', 'DERIVED_FROM', 'CONTAINS',
] as const;

/** 来源域判定表：按域名把证据归类，决定它能支撑多强的 claim。 */
const BENCHMARK_DOMAINS = ['gsmarena.com', 'notebookcheck.net', 'anandtech.com', 'techpowerbench.com', 'geeksbench.com'];
const FORUM_DOMAINS = ['reddit.com', 'forums.', 'quora.com'];
const SOCIAL_DOMAINS = ['youtube.com', 'twitter.com', 'x.com', 'facebook.com', 'tiktok.com', 'instagram.com'];

/** 证据可判定的来源类型。 */
export const SOURCE_TYPES = [
  'OFFICIAL', 'BENCHMARK', 'FORUM', 'SOCIAL', 'ACADEMIC',
  'DOCUMENT', 'VIDEO', 'IMAGE', 'WEB',
] as const;

/** 各 claim 类型的确定性置信度兜底（确定性整理路径用）。 */
export const FALLBACK_CONFIDENCE: Record<string, number> = {
  OFFICIAL_FACT: 0.9,
  MEASURED_RESULT: 0.75,
  VISUAL_OBSERVATION: 0.6,
  TECHNICAL_ANALYSIS: 0.55,
  USER_REPORT: 0.5,
  INFERENCE: 0.45,
  OPINION: 0.4,
  UNKNOWN: 0.3,
};

// ==================== 输出契约（与旧系统完全一致） ====================

export interface OrganizedFact {
  objectId: string;
  variantId?: string;
  claim: string;
  claimType: string;
  confidence: number;
  evidenceIds: string[];
  observedAt?: string;
  validFrom?: string;
  validTo?: string;
}

export interface OrganizedRelation {
  objectId: string;
  targetId: string;
  relationType: string;
  description?: string;
}

export interface OrganizedKnowledge {
  facts: OrganizedFact[];
  relations: OrganizedRelation[];
  categories: string[];
  unknowns: string[];
  summary: string;
}

// ==================== 1-5,7,8：标量级合规函数 ====================

/**
 * 置信度夹到 [0,1]。越界、NaN、Infinity → 0.5（中性值）。
 *
 * ⚠ 已知限制（与旧系统逐字一致，刻意未在合并期改动）：
 *   JS 的 `Number(null) === 0`、`Number('') === 0`，所以 **null / undefined /
 *   空串会走到 0**，而不是 0.5。后果：AI 漏传 confidence 字段时，该 fact 会被
 *   打成「置信度 0」（语义≈确定为假），从而被下游过滤或降权 —— 这很可能不是
 *   期望行为，但改变它属于**产品语义变更**，不应在一次「合并旧系统能力」的
 *   改动里静默发生。已由测试钉住现状（orgCompliance.test.ts A 段），
 *   若判定应改为 0.5，需单独一轮并同步评估对既有数据的影响。
 *   另注：`Number([]) === 0`、`Number([5]) === 5`，数组输入同样落到此路径。
 */
export function clampConfidence(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0.5;
  return n;
}

/** claim 类型白名单。不认识 → 'UNKNOWN'（NOT 丢弃该条：类型可降级，内容不可丢）。 */
export function validClaimType(v: unknown): string {
  const s = String(v ?? '').toUpperCase();
  return (VALID_CLAIM_TYPES as readonly string[]).includes(s) ? s : 'UNKNOWN';
}

/** 关系类型白名单。不认识 → 'RELATED_TO'。 */
export function validRelationType(v: unknown): string {
  const s = String(v ?? '').toUpperCase();
  return (RELATION_TYPES as readonly string[]).includes(s) ? s : 'RELATED_TO';
}

/** claim 归一化：压空白 + 取首句 + 300 字上限。 */
export function firstSentence(text: unknown, limit = 300): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?[.!?。？])/);
  return (m ? m[1] : t).slice(0, limit);
}

/** 证据来源类型推导（域名 + 显式字段，确定性）。 */
export function deriveSourceType(ev: any): string {
  const st = String(ev?.sourceType ?? '').toUpperCase();
  if ((SOURCE_TYPES as readonly string[]).includes(st)) return st;
  if (ev?.metadata?.isOfficial || ev?.isOfficial) return 'OFFICIAL';
  const et = String(ev?.evidenceType ?? '').toUpperCase();
  if (et === 'IMAGE' || et === 'VIDEO') return et;
  if (et === 'MEASUREMENT') return 'BENCHMARK';
  const domain = String(ev?.domain ?? '').toLowerCase();
  if (BENCHMARK_DOMAINS.some((d) => domain.includes(d))) return 'BENCHMARK';
  if (FORUM_DOMAINS.some((d) => domain.includes(d))) return 'FORUM';
  if (SOCIAL_DOMAINS.some((d) => domain.includes(d))) return 'SOCIAL';
  return 'WEB';
}

/** 来源类型 → claim 类型（确定性整理路径的核心映射）。 */
export function sourceTypeToClaimType(st: string): string {
  switch (String(st ?? '').toUpperCase()) {
    case 'OFFICIAL': return 'OFFICIAL_FACT';
    case 'BENCHMARK':
    case 'MEASUREMENT': return 'MEASURED_RESULT';
    case 'FORUM':
    case 'SOCIAL': return 'USER_REPORT';
    case 'IMAGE':
    case 'VIDEO': return 'VISUAL_OBSERVATION';
    case 'ACADEMIC': return 'OFFICIAL_FACT';
    case 'DOCUMENT': return 'TECHNICAL_ANALYSIS';
    default: return 'TECHNICAL_ANALYSIS';
  }
}

/** 去掉 claim 里的自媒体报道措辞（"据报道"等），否则同一事实出现多种写法就
 *  绕过去重。归一化键必须与「用户看到的 claim」一致，否则前端查重对视不上。 */
export function normalizeClaimKey(claim: unknown): string {
  return String(claim ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ==================== 3-4：幻觉防护（合并后新增的闸门） ====================

export interface HallucinationGuardSets {
  /** 本次确实传入的证据 id 集合。空集合 = 不启用该防护（旧系统同款语义）。 */
  knownEvidence?: Set<string>;
  /** 本次确实存在的 variant id 集合。 */
  knownVariants?: Set<string>;
}

/**
 * evidenceIds 幻觉防护。
 *
 * AI 有能力「引用」一个不存在的证据 id。若不拦，库里会出现指向不存在证据的
 * fact，且事后无法分辨是 AI 编造还是证据被删。规则：
 *   · knownEvidence 为空集合 / 未提供 → 不过滤（调用方明确表示「无对照集」）
 *   · 否则**只保留**出现在集合里的 id；被过滤掉的 id 通过 dropped 回报，
 *     由调用方决定是否记录（不静默）
 */
export function guardEvidenceIds(
  evidenceIds: unknown,
  guard: HallucinationGuardSets,
): { kept: string[]; dropped: string[] } {
  const all = (Array.isArray(evidenceIds) ? evidenceIds : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean);
  const known = guard.knownEvidence;
  if (!known || known.size === 0) return { kept: all, dropped: [] };
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const id of all) (known.has(id) ? kept : dropped).push(id);
  return { kept, dropped };
}

/**
 * variantId 幻觉防护：只保留本次确实存在的 variant。
 * 没有已知集合或 variantId 为空 → 不加该字段（旧系统语义：不猜）。
 */
export function guardVariantId(
  variantId: unknown,
  guard: HallucinationGuardSets,
): string | null {
  const v = String(variantId ?? '').trim();
  if (!v) return null;
  const known = guard.knownVariants;
  if (!known || known.size === 0) return v;   // 无对照集 → 原样（旧系统同款）
  return known.has(v) ? v : null;
}

// ==================== sanitizeOrganized ====================

/**
 * 把 AI 返回的解析结果整形成可落库的 OrganizedKnowledge。
 *
 * 这是旧系统 sanitizeOrganized 的忠实移植 + 合并时新增的 returns 报告：
 *   · claim/relation/category 类型全部过白名单
 *   · confidence 全部夹取
 *   · evidenceIds / variantId 全部过幻觉防护
 *   · 按 claim 归一化键去重
 *   · 全部硬上限生效
 *
 * 返回 `report` 字段说明「清洗掉了什么」，供观测与 admin 页展示 ——
 * 不静默修改 AI 输出。
 */
export function sanitizeOrganized(
  parsed: any,
  objectId: string,
  guard: HallucinationGuardSets = {},
): { organized: OrganizedKnowledge; report: SanitizeReport } {
  const knownEvidence = guard.knownEvidence;
  const facts: OrganizedFact[] = [];
  const seen = new Set<string>();
  const report: SanitizeReport = {
    factsIn: 0, factsOut: 0, droppedEmptyClaim: 0, droppedDuplicate: 0,
    droppedEvidenceIds: 0, droppedVariantIds: 0, claimTypeNormalized: 0,
    confidenceClamped: 0,
    relationsOut: 0, categoriesOut: 0, unknownsOut: 0,
  };

  for (const raw of Array.isArray(parsed?.facts) ? parsed.facts : []) {
    report.factsIn++;
    if (!raw || typeof raw !== 'object') continue;
    const claim = firstSentence(raw.claim);
    if (!claim.trim()) { report.droppedEmptyClaim++; continue; }
    const key = normalizeClaimKey(claim);
    if (seen.has(key)) { report.droppedDuplicate++; continue; }
    seen.add(key);

    const g = guardEvidenceIds(raw.evidenceIds, guard);
    report.droppedEvidenceIds += g.dropped.length;
    const variantId = guardVariantId(raw.variantId, guard);
    if (variantId === null && String(raw.variantId ?? '').trim()) report.droppedVariantIds++;

    const rawClaimType = String(raw.claimType ?? '');
    const claimType = validClaimType(rawClaimType);
    if (claimType !== rawClaimType.toUpperCase() && rawClaimType) report.claimTypeNormalized++;
    const confidence = clampConfidence(raw.confidence);
    const rawConf = Number(raw.confidence);
    if (!Number.isFinite(rawConf) || rawConf < 0 || rawConf > 1) report.confidenceClamped++;

    const fact: OrganizedFact = {
      objectId, claim, claimType, confidence, evidenceIds: g.kept,
    };
    if (variantId) fact.variantId = variantId;
    if (raw.observedAt) fact.observedAt = String(raw.observedAt);
    if (raw.validFrom) fact.validFrom = String(raw.validFrom);
    if (raw.validTo) fact.validTo = String(raw.validTo);
    facts.push(fact);
    if (facts.length >= ORG_LIMITS.MAX_FACTS) break;
  }
  report.factsOut = facts.length;

  const relations: OrganizedRelation[] = [];
  const relSeen = new Set<string>();
  for (const raw of Array.isArray(parsed?.relations) ? parsed.relations : []) {
    if (!raw || typeof raw !== 'object') continue;
    const targetId = String(raw.targetId ?? '').trim();
    if (!targetId) continue;
    const relationType = validRelationType(raw.relationType);
    const key = `${targetId}::${relationType}`;
    if (relSeen.has(key)) continue;
    relSeen.add(key);
    relations.push({
      objectId, targetId, relationType,
      ...(raw.description ? { description: String(raw.description).slice(0, 300) } : {}),
    });
    if (relations.length >= ORG_LIMITS.MAX_RELATIONS) break;
  }

  const rawCategories: any[] = Array.isArray(parsed?.categories) ? parsed.categories : [];
  const categories = Array.from(new Set(
    rawCategories.map((c: any) => String(c ?? '').trim()).filter(Boolean),
  )).slice(0, ORG_LIMITS.MAX_CATEGORIES);

  const rawUnknowns: any[] = Array.isArray(parsed?.unknowns) ? parsed.unknowns : [];
  const unknowns = rawUnknowns
    .map((u: any) => String(u ?? '').trim())
    .filter(Boolean)
    .slice(0, ORG_LIMITS.MAX_UNKNOWNS);

  report.relationsOut = relations.length;
  report.categoriesOut = categories.length;
  report.unknownsOut = unknowns.length;

  return {
    organized: {
      facts, relations, categories, unknowns,
      summary: String(parsed?.summary ?? '').slice(0, 1000) || 'Organized (no summary provided).',
    },
    report,
  };
}

export interface SanitizeReport {
  factsIn: number;
  factsOut: number;
  droppedEmptyClaim: number;
  droppedDuplicate: number;
  /** 被幻觉防护丢弃的证据引用数（>0 说明 AI 编造了引用） */
  droppedEvidenceIds: number;
  droppedVariantIds: number;
  claimTypeNormalized: number;
  confidenceClamped: number;
  relationsOut: number;
  categoriesOut: number;
  unknownsOut: number;
}

// ==================== deterministicOrganize ====================

/**
 * 确定性整理回退（旧系统同款）：按证据来源类型分组产出 facts。
 * AI 不可用 / 返回畸形 JSON 时使用 —— **不是空结果，是有据可依的结果**。
 */
export function deterministicOrganize(
  evidence: any[],
  conflicts: any[],
  objectId: string,
): OrganizedKnowledge {
  const ev = Array.isArray(evidence) ? evidence : [];

  const groups = new Map<string, any[]>();
  for (const item of ev) {
    const st = deriveSourceType(item);
    const list = groups.get(st) ?? [];
    list.push(item);
    groups.set(st, list);
  }

  const facts: OrganizedFact[] = [];
  const seen = new Set<string>();
  for (const item of ev) {
    const st = deriveSourceType(item);
    const claimType = sourceTypeToClaimType(st);
    const claim = firstSentence(String(item?.metadata?.title || item?.content || ''));
    if (!claim.trim()) continue;
    const key = normalizeClaimKey(claim);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      objectId, claim, claimType,
      confidence: FALLBACK_CONFIDENCE[claimType] ?? 0.5,
      evidenceIds: item?.id ? [String(item.id)] : [],
      ...(item?.observedAt ? { observedAt: String(item.observedAt) } : {}),
    });
    if (facts.length >= ORG_LIMITS.MAX_FACTS) break;
  }

  const unknowns = (Array.isArray(conflicts) ? conflicts : [])
    .map((c: any) => (c?.claim
      ? `${c.claim} (${Array.isArray(c.values) ? c.values.join(' vs ') : String(c.possibleReason ?? '')})`
      : null))
    .filter(Boolean)
    .slice(0, ORG_LIMITS.MAX_UNKNOWNS);

  const groupDesc = Array.from(groups.entries())
    .map(([st, items]) => `${st}(${items.length})`)
    .join(', ');

  return {
    facts, relations: [], categories: ['general'], unknowns,
    summary: `Deterministic organization (AI unavailable): ${facts.length} facts from ${ev.length} evidence items, grouped by source type [${groupDesc}]`,
  };
}

/** 冲突条目的可读化（新旧路径共用，观测页展示同一格式）。 */
export function describeConflicts(conflicts: unknown): string[] {
  return (Array.isArray(conflicts) ? conflicts : [])
    .map((c: any) => (c?.claim
      ? `${c.claim} (${Array.isArray(c.values) ? c.values.join(' vs ') : String(c.possibleReason ?? '')})`
      : null))
    .filter(Boolean) as string[];
}
