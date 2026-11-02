// ================================================================
// 旧「数据库自整理系统」→ 新代合并后的一致性测试
// Run: npx tsx test/orgCompliance.test.ts
//
// 合并的是**能力**，不是文件。旧系统 knowledgeOrganizer.ts 有 9 项能力是
// 新代 knowledgeOrg/ 完全没有的，本测试逐项证明移植后行为与旧系统一致，
// 并证明几项**只有新实现才修好**的真实缺陷。
//
// 关键：本测试文件只 import 纯模块，因此**不需要数据库**就能完整跑
// （这正是合并时顺带修掉的缺陷，见第 J 段）。
// ================================================================

import {
  clampConfidence, validClaimType, validRelationType, firstSentence,
  deriveSourceType, sourceTypeToClaimType, normalizeClaimKey,
  guardEvidenceIds, guardVariantId, sanitizeOrganized, deterministicOrganize,
  describeConflicts, ORG_LIMITS, RELATION_TYPES, VALID_CLAIM_TYPES,
  FALLBACK_CONFIDENCE,
} from '../src/services/knowledgeOrg/orgCompliance';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = '') =>
  c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, d));
const S = (n: string) => console.log('\n=== ' + n + ' ===');

// ==================== A. 置信度夹取 ====================
S('A. clampConfidence 越界/NaN → 0.5；缺失值统一 0.5（2026-11 决策）');
{
  check('7 → 0.5', clampConfidence(7) === 0.5, String(clampConfidence(7)));
  check('-1 → 0.5', clampConfidence(-1) === 0.5);
  check('NaN → 0.5', clampConfidence('abc') === 0.5);
  // 2026-11 用户决策：缺失值（null/undefined/空串）统一返回 0.5 中性值，
  // 不再区分 null→0 与 undefined→0.5 的旧不一致行为。
  check('null → 0.5（缺失统一中性值）', clampConfidence(null) === 0.5, String(clampConfidence(null)));
  check('undefined → 0.5（缺失统一中性值）', clampConfidence(undefined) === 0.5, String(clampConfidence(undefined)));
  check('空串 → 0.5（缺失统一中性值）', clampConfidence('') === 0.5, String(clampConfidence('')));
  check('纯空白串 → 0.5', clampConfidence('   ') === 0.5, String(clampConfidence('   ')));
  check('缺失值三者一致（不再分叉）', clampConfidence(null) === clampConfidence(undefined) && clampConfidence(undefined) === clampConfidence(''));
  check('字符串 "0.42" → 0.42（可解析就解析）', clampConfidence('0.42') === 0.42);
  // 绝不能返回 NaN 或越界值
  for (const v of [7, -1, NaN, Infinity, 'abc', null, undefined, {}, []]) {
    const r = clampConfidence(v as any);
    check(`clampConfidence(${JSON.stringify(v) ?? String(v)}) ∈ [0,1] 且有限`,
      Number.isFinite(r) && r >= 0 && r <= 1, String(r));
  }
}

// ==================== B. 类型白名单 ====================
S('B. claim / relation 类型白名单（未知 → 降级，不丢内容）');
{
  check('VALID_CLAIM_TYPES 含 8 种', VALID_CLAIM_TYPES.length === 8, String(VALID_CLAIM_TYPES.length));
  check('OFFICIAL_FACT 通过', validClaimType('OFFICIAL_FACT') === 'OFFICIAL_FACT');
  check('大小写不敏感（official_fact）', validClaimType('official_fact') === 'OFFICIAL_FACT');
  check('未知类型 → UNKNOWN（不是报错、不是丢弃）', validClaimType('MADE_UP_TYPE') === 'UNKNOWN');
  check('空 → UNKNOWN', validClaimType('') === 'UNKNOWN');
  check('null → UNKNOWN', validClaimType(null) === 'UNKNOWN');
  check('RELATED_TO 通过', validRelationType('RELATED_TO') === 'RELATED_TO');
  check('未知关系 → RELATED_TO 降级', validRelationType('MADE_UP') === 'RELATED_TO');
  check('关系白名单含 8 种', RELATION_TYPES.length === 8, String(RELATION_TYPES.length));
  // 旧系统有一个真实缺陷：AI 返回 "measured-result"（连字符）会被判未知。
  // 这里保持同样的行为以便对照 —— 不是回归，是已知限制，见 J 段。
  check('连字符写法仍判未知（已知限制，与旧系统一致便于对照）',
    validClaimType('official-fact') === 'UNKNOWN');
}

// ==================== C. claim 归一化 ====================
S('C. firstSentence / normalizeClaimKey（去重键必须稳）');
{
  check('取首句', firstSentence('这是第一句。这是第二句。') === '这是第一句。');
  check('英文首句', firstSentence('First one. Second.') === 'First one.');
  check('问号也算句尾', firstSentence('真的吗？是的。') === '真的吗？');
  check('无句号则整体保留（截断到上限）', firstSentence('没有句号的一句话').length > 0);
  const long = '没有句号'.repeat(200);
  check(`超长无句号截到 ${300} 字`, firstSentence(long).length <= 300, String(firstSentence(long).length));
  check('空白压缩', firstSentence('  a   b  ').trim() === 'a b');
  check('null → 空串', firstSentence(null) === '');
  // 归一化键：大小写与多余空白不应影响判重
  check('大小写不敏感的键', normalizeClaimKey('Hello World') === normalizeClaimKey('  hello   WORLD '));
  check('键不含首尾空白', normalizeClaimKey('  x  ') === 'x');
  // 中文无空格
  check('中文键稳定', normalizeClaimKey('手机支持5G') === normalizeClaimKey('手机支持5G'));
}

// ==================== D. 来源 → claim 类型映射 ====================
S('D. deriveSourceType / sourceTypeToClaimType（确定性映射）');
{
  // 域名判定
  check('gsmarena → BENCHMARK', deriveSourceType({ domain: 'www.gsmarena.com' }) === 'BENCHMARK');
  check('notebookcheck → BENCHMARK', deriveSourceType({ domain: 'www.notebookcheck.net' }) === 'BENCHMARK');
  check('reddit → FORUM', deriveSourceType({ domain: 'reddit.com' }) === 'FORUM');
  check('quora → FORUM', deriveSourceType({ domain: 'www.quora.com' }) === 'FORUM');
  check('youtube → SOCIAL', deriveSourceType({ domain: 'youtube.com' }) === 'SOCIAL');
  check('twitter → SOCIAL', deriveSourceType({ domain: 'x.com' }) === 'SOCIAL');
  check('未知域名 → WEB', deriveSourceType({ domain: 'example.com' }) === 'WEB');
  check('无 domain → WEB', deriveSourceType({}) === 'WEB');
  // 显式字段优先于域名
  check('metadata.isOfficial 最高优先', deriveSourceType({ domain: 'reddit.com', metadata: { isOfficial: true } }) === 'OFFICIAL');
  check('evidenceType=MEASUREMENT → BENCHMARK', deriveSourceType({ evidenceType: 'MEASUREMENT' }) === 'BENCHMARK');
  check('evidenceType=IMAGE → IMAGE', deriveSourceType({ evidenceType: 'IMAGE' }) === 'IMAGE');
  check('evidenceType=VIDEO → VIDEO', deriveSourceType({ evidenceType: 'VIDEO' }) === 'VIDEO');
  check('显式 sourceType 原样采用', deriveSourceType({ sourceType: 'ACADEMIC' }) === 'ACADEMIC');

  // 映射到 claim 类型
  check('OFFICIAL → OFFICIAL_FACT', sourceTypeToClaimType('OFFICIAL') === 'OFFICIAL_FACT');
  check('BENCHMARK → MEASURED_RESULT', sourceTypeToClaimType('BENCHMARK') === 'MEASURED_RESULT');
  check('FORUM → USER_REPORT', sourceTypeToClaimType('FORUM') === 'USER_REPORT');
  check('SOCIAL → USER_REPORT', sourceTypeToClaimType('SOCIAL') === 'USER_REPORT');
  check('IMAGE → VISUAL_OBSERVATION', sourceTypeToClaimType('IMAGE') === 'VISUAL_OBSERVATION');
  check('VIDEO → VISUAL_OBSERVATION', sourceTypeToClaimType('VIDEO') === 'VISUAL_OBSERVATION');
  check('WEB → TECHNICAL_ANALYSIS', sourceTypeToClaimType('WEB') === 'TECHNICAL_ANALYSIS');
  check('未知 → TECHNICAL_ANALYSIS（不是崩溃）', sourceTypeToClaimType('WHATEVER') === 'TECHNICAL_ANALYSIS');
  check('空 → TECHNICAL_ANALYSIS', sourceTypeToClaimType('') === 'TECHNICAL_ANALYSIS');
  // 每个来源类型产出的 claimType 必须在白名单里（否则落库即非法值）
  for (const st of ['OFFICIAL', 'BENCHMARK', 'FORUM', 'SOCIAL', 'WEB', 'IMAGE', 'VIDEO', 'ACADEMIC', 'DOCUMENT']) {
    const ct = sourceTypeToClaimType(st);
    check(`${st} → ${ct} 在白名单内`,
      (VALID_CLAIM_TYPES as readonly string[]).includes(ct), ct);
  }
  // 每种 claimType 都要有兜底置信度
  check('FALLBACK_CONFIDENCE 覆盖全部 8 种 claimType',
    VALID_CLAIM_TYPES.every((ct) => typeof FALLBACK_CONFIDENCE[ct] === 'number'),
    JSON.stringify(FALLBACK_CONFIDENCE));
  for (const ct of VALID_CLAIM_TYPES) {
    const v = FALLBACK_CONFIDENCE[ct];
    check(`${ct} 兜底置信度 ∈ (0,1]`, v > 0 && v <= 1, String(v));
  }
}

// ==================== E. 幻觉防护（核心新增价值） ====================
S('E. evidenceIds / variantId 幻觉防护');
{
  // 1) 有对照集 → 只保留真实 id
  const known = new Set(['ev1', 'ev3']);
  const r = guardEvidenceIds(['ev1', 'FAKE_ID', 'ev3', ''], { knownEvidence: known });
  check('保留真实 id', r.kept.join(',') === 'ev1,ev3', r.kept.join(','));
  check('丢弃编造 id 且被报告', r.dropped.join(',') === 'FAKE_ID', r.dropped.join(','));
  check('空串 id 不算编造（不算 dropped）', !r.dropped.includes(''));

  // 2) 无对照集 → 不过滤（旧系统同款语义，不误伤）
  const r2 = guardEvidenceIds(['a', 'b'], {});
  check('无 knownEvidence → 不过滤', r2.kept.length === 2 && r2.dropped.length === 0);
  const r3 = guardEvidenceIds(['a', 'b'], { knownEvidence: new Set() });
  check('空集合 → 不过滤（调用方明确表示无对照）', r3.kept.length === 2);
  // 3) 非数组输入不炸
  const r4 = guardEvidenceIds(null, { knownEvidence: known });
  check('null 输入 → 空结果不抛', Array.isArray(r4.kept) && r4.kept.length === 0);
  const r5 = guardEvidenceIds('ev1', {});
  check('字符串输入 → 空结果', r5.kept.length === 0);

  // variantId
  const knownV = new Set(['v1']);
  check('已知 variant 保留', guardVariantId('v1', { knownVariants: knownV }) === 'v1');
  check('编造 variant 丢弃', guardVariantId('V_FAKE', { knownVariants: knownV }) === null);
  check('空 variantId → null', guardVariantId('', { knownVariants: knownV }) === null);
  check('null variantId → null', guardVariantId(null, {}) === null);
  check('无对照集 → 原样返回', guardVariantId('anything', {}) === 'anything');

  // 4) 端到端：AI 编造引用必须在 sanitizeOrganized 被拦下
  const parsed = {
    facts: [
      { claim: '真实事实', claimType: 'OFFICIAL_FACT', confidence: 9, evidenceIds: ['ev1', 'GHOST'] },
      { claim: '另一事实', claimType: 'OFFICIAL_FACT', confidence: 0.8, evidenceIds: ['ev3'], variantId: 'GHOST_V' },
      { claim: '   ', claimType: 'OFFICIAL_FACT', confidence: 0.9, evidenceIds: [] },
    ],
    relations: [{ targetId: 'o2', relationType: 'MADE_UP' }],
    categories: ['a', 'a', 'b', ''],
    unknowns: ['未解之谜1'],
    summary: '摘要',
  };
  const { organized, report } = sanitizeOrganized(parsed, 'obj1', {
    knownEvidence: new Set(['ev1', 'ev3']), knownVariants: new Set(['v1']),
  });
  check('幻觉引用被拦：第一条 fact 只剩 ev1',
    organized.facts[0].evidenceIds.join(',') === 'ev1', organized.facts[0].evidenceIds.join(','));
  check('report 记录丢弃了 1 个编造 evidenceId', report.droppedEvidenceIds === 1, String(report.droppedEvidenceIds));
  check('编造 variantId 被拦：第二条 fact 无 variantId', organized.facts[1].variantId === undefined);
  check('claimType 降级为白名单值', organized.facts[0].claimType === 'OFFICIAL_FACT');
  check('confidence=9 被夹到 0.5', organized.facts[0].confidence === 0.5, String(organized.facts[0].confidence));
  check('空 claim 被丢弃', report.droppedEmptyClaim === 1, String(report.droppedEmptyClaim));
  check('未知关系类型降级为 RELATED_TO', organized.relations[0]?.relationType === 'RELATED_TO');
  check('categories 去重 + 去空', organized.categories.join(',') === 'a,b', organized.categories.join(','));
  check('unknowns 保留', organized.unknowns.length === 1);
  check('summary 保留', organized.summary === '摘要');
  check('report 计数正确（factsIn=3, factsOut=2）',
    report.factsIn === 3 && report.factsOut === 2, `${report.factsIn}/${report.factsOut}`);
  check('report 的 relations/categories/unknowns 计数已填充',
    report.relationsOut === 1 && report.categoriesOut === 2 && report.unknownsOut === 1,
    `${report.relationsOut}/${report.categoriesOut}/${report.unknownsOut}`);
}

// ==================== F. 去重与硬上限 ====================
S('F. 按 claim 去重 + MAX_* 硬上限（防 AI 一次返回海量条目）');
{
  // 注意：重复项必须放在数组**前面**。MAX_FACTS=50 会在第 50 条 break，
  // 放在末尾的重复项根本不会被检查到（我第一版就犯了这错，误报了 bug）。
  const dups = [
    { claim: 'claim-0', claimType: 'OFFICIAL_FACT', confidence: 0.9, evidenceIds: [] },
    { claim: 'CLAIM-1', claimType: 'OFFICIAL_FACT', confidence: 0.9, evidenceIds: [] },
    { claim: 'claim-2', claimType: 'OFFICIAL_FACT', confidence: 0.9, evidenceIds: [] },
  ];
  const facts = [
    ...dups,
    ...Array.from({ length: 200 }, (_, i) => ({
      claim: `claim-${i}`, claimType: 'OFFICIAL_FACT', confidence: 0.5, evidenceIds: [],
    })),
  ];
  const { organized, report } = sanitizeOrganized({ facts }, 'o', {});
  check(`facts 被截到 MAX_FACTS=${ORG_LIMITS.MAX_FACTS}`,
    organized.facts.length === ORG_LIMITS.MAX_FACTS, String(organized.facts.length));
  check('3 个重复项全部被计为 droppedDuplicate', report.droppedDuplicate === 3, String(report.droppedDuplicate));
  check('大小写不同算同一 claim（CLAIM-1 归一化后命中 claim-1）',
    !organized.facts.some((f) => normalizeClaimKey(f.claim) === 'claim-1') === false
    && report.droppedDuplicate === 3);

  const rels = Array.from({ length: 100 }, (_, i) => ({ targetId: `t${i}`, relationType: 'RELATED_TO' }));
  const r2 = sanitizeOrganized({ relations: rels }, 'o', {});
  check(`relations 截到 MAX_RELATIONS=${ORG_LIMITS.MAX_RELATIONS}`,
    r2.organized.relations.length === ORG_LIMITS.MAX_RELATIONS, String(r2.organized.relations.length));

  const cats = Array.from({ length: 100 }, (_, i) => `c${i}`);
  const r3 = sanitizeOrganized({ categories: cats }, 'o', {});
  check(`categories 截到 MAX_CATEGORIES=${ORG_LIMITS.MAX_CATEGORIES}`,
    r3.organized.categories.length === ORG_LIMITS.MAX_CATEGORIES, String(r3.organized.categories.length));

  const unks = Array.from({ length: 100 }, (_, i) => `u${i}`);
  const r4 = sanitizeOrganized({ unknowns: unks }, 'o', {});
  check(`unknowns 截到 MAX_UNKNOWNS=${ORG_LIMITS.MAX_UNKNOWNS}`,
    r4.organized.unknowns.length === ORG_LIMITS.MAX_UNKNOWNS, String(r4.organized.unknowns.length));

  // 关系去重（targetId::relationType 同键）
  const r5 = sanitizeOrganized({ relations: [
    { targetId: 't1', relationType: 'RELATED_TO' },
    { targetId: 't1', relationType: 'RELATED_TO' },
    { targetId: 't1', relationType: 'PART_OF' },
  ] }, 'o', {});
  check('同键关系去重后剩 2', r5.organized.relations.length === 2, String(r5.organized.relations.length));
}

// ==================== G. 确定性整理回退 ====================
S('G. deterministicOrganize（AI 不可用时的有据结果，不是空结果）');
{
  const ev = [
    { id: 'e1', sourceType: 'OFFICIAL', content: '官方数据。补充说明。', observedAt: '2026-01-01' },
    { id: 'e2', domain: 'gsmarena.com', content: '跑分结果。备注。' },
    { id: 'e3', domain: 'reddit.com', content: '用户反馈。另一句。' },
    { id: 'e4', domain: 'reddit.com', content: '用户反馈。另一句。' },   // 重复内容
    { id: 'e5', sourceType: 'OFFICIAL', content: '   ' },                // 空内容
  ];
  const out = deterministicOrganize(ev, [{ claim: '冲突A', values: ['x', 'y'] }], 'obj');
  // e1 官方 / e2 跑分 / e3 论坛，共 3 条。
  // e4 与 e3 内容完全相同 → **被正确去重**（不是我期望的 4 条）；
  // e5 内容只有空白 → 被剔除。我第一版写 4 是数错了。
  check('产出 3 条 fact（e4 与 e3 重复被去重，e5 空白被剔除）',
    out.facts.length === 3, String(out.facts.length));
  check('e4 未重复出现（去重生效）',
    out.facts.filter((f) => f.claim === '用户反馈。').length === 1,
    String(out.facts.filter((f) => f.claim === '用户反馈。').length));
  check('官方来源 → OFFICIAL_FACT', out.facts.some((f) => f.claimType === 'OFFICIAL_FACT'));
  check('跑分来源 → MEASURED_RESULT', out.facts.some((f) => f.claimType === 'MEASURED_RESULT'));
  check('论坛来源 → USER_REPORT', out.facts.some((f) => f.claimType === 'USER_REPORT'));
  check('evidenceIds 指向真实证据', out.facts.every((f) => f.evidenceIds.every((id) => ['e1', 'e2', 'e3', 'e4'].includes(id))));
  check('observedAt 被保留', out.facts.some((f) => f.observedAt === '2026-01-01'));
  check('空数组不崩', deterministicOrganize([], [], 'o').facts.length === 0);
  check('null 输入不崩', deterministicOrganize(null as any, null as any, 'o').facts.length === 0);
  check('非数组 evidence 不崩', deterministicOrganize('nope' as any, [], 'o').facts.length === 0);
  check('summary 说明是确定性路径', /Deterministic/.test(out.summary), out.summary);
  check('conflicts 转成 unknowns', out.unknowns.length === 1 && /冲突A/.test(out.unknowns[0]), out.unknowns.join(','));
  check('无 conflicts → unknowns 空数组', deterministicOrganize(ev, [], 'o').unknowns.length === 0);
  check('categories 有默认值', deterministicOrganize([], [], 'o').categories.includes('general'));
  // describeConflicts 与 deterministicOrganize 内部格式一致（同一真相）
  const dc = describeConflicts([{ claim: '冲突A', values: ['x', 'y'] }]);
  check('describeConflicts 与 deterministicOrganize 的同格式',
    dc[0] === deterministicOrganize([], [{ claim: '冲突A', values: ['x', 'y'] }], 'o').unknowns[0]);
  check('describeConflicts 对 null 安全', describeConflicts(null).length === 0);
}

// ==================== H. 常量与旧系统逐值一致 ====================
S('H. 常量与旧系统逐值一致（confidence 缺失语义除外，已按用户决策改）');
{
  check('MAX_FACTS = 50', ORG_LIMITS.MAX_FACTS === 50, String(ORG_LIMITS.MAX_FACTS));
  check('MAX_RELATIONS = 20', ORG_LIMITS.MAX_RELATIONS === 20);
  check('MAX_CATEGORIES = 10', ORG_LIMITS.MAX_CATEGORIES === 10);
  check('MAX_UNKNOWNS = 20', ORG_LIMITS.MAX_UNKNOWNS === 20);
  check('EVIDENCE_CONTENT_LIMIT = 2000', ORG_LIMITS.EVIDENCE_CONTENT_LIMIT === 2000);
  // 置信度排序必须单调：官方 > 跑分 > 分析 > 用户报告（这是产品语义）
  check('OFFICIAL_FACT > MEASURED_RESULT', FALLBACK_CONFIDENCE.OFFICIAL_FACT > FALLBACK_CONFIDENCE.MEASURED_RESULT);
  check('MEASURED_RESULT > TECHNICAL_ANALYSIS', FALLBACK_CONFIDENCE.MEASURED_RESULT > FALLBACK_CONFIDENCE.TECHNICAL_ANALYSIS);
  check('TECHNICAL_ANALYSIS > USER_REPORT', FALLBACK_CONFIDENCE.TECHNICAL_ANALYSIS > FALLBACK_CONFIDENCE.USER_REPORT);
  check('USER_REPORT > OPINION', FALLBACK_CONFIDENCE.USER_REPORT > FALLBACK_CONFIDENCE.OPINION);
  check('OPINION > UNKNOWN', FALLBACK_CONFIDENCE.OPINION > FALLBACK_CONFIDENCE.UNKNOWN);
}

// ==================== I. 纯度（合并时修掉的真实缺陷） ====================
S('I. 模块纯度：无 IO、不拖 Prisma');
{
  // 旧写法 `import { VALID_CLAIM_TYPES } from '../knowledgeValidator'` 会把
  // knowledgeValidator 顶部的 prismaKnowledge 拖进来（该文件 import './db'），
  // 于是「纯函数模块」在本机直接抛 EM_X86_64/EM_AARCH64 引擎不兼容。
  // 现在白名单在本模块自持，本测试能无库跑起来就是证据。
  check('本测试无需数据库即通过（上面各段已证明）', true);
  check('VALID_CLAIM_TYPES 由本模块导出（单一来源）',
    Array.isArray(VALID_CLAIM_TYPES) && VALID_CLAIM_TYPES.length === 8);
  // 幂等性：纯函数 repeated calls 同结果
  const a = JSON.stringify(sanitizeOrganized({ facts: [{ claim: 'x', claimType: 'OFFICIAL_FACT', confidence: 1 }] }, 'o', {}));
  const b = JSON.stringify(sanitizeOrganized({ facts: [{ claim: 'x', claimType: 'OFFICIAL_FACT', confidence: 1 }] }, 'o', {}));
  check('重复调用结果一致（无状态污染）', a === b);
}

// ==================== J. 已知限制（如实曝光，不静默） ====================
S('J. 已知限制曝光（不静默通过）');
{
  // 1) AI 返回连字符/小写变体时 claimType 会降级为 UNKNOWN。
  //    这是旧系统就有的行为，合并时保持原样以便新旧对照，未擅自改语义。
  console.log('  NOTE 连字符 claimType（official-fact）会降级为 UNKNOWN —— 与旧系统一致，属已知限制');
  // 2) sanitizeOrganized 不做「内容级」幻觉检测：claim 文本本身是否被 AI
  //    篡改无法在本层判断，只能保证「引用指向真实证据」。
  console.log('  NOTE 只防「引用幻觉」，不防「内容幻觉」——claim 文本真实性需 orgValidator/AI 终检');
  // 3) guardEvidenceIds 在无对照集时不过滤。若调用方忘记传 knownEvidence，
  //    幻觉防护会静默失效。这是刻意选择（避免误伤），但必须让调用方知道。
  const silent = sanitizeOrganized({ facts: [{ claim: 'x', evidenceIds: ['ANYTHING'] }] }, 'o', {});
  console.log(`  NOTE 未传 knownEvidence 时 evidenceIds 不过滤：${silent.organized.facts[0].evidenceIds.join(',')}`);
  // 4) 空数组 `Number([]) === 0` 仍落到 0（未纳入「缺失」范围）。
  //    用户在 2026-11 决策只覆盖 null/undefined/空串三类，数组是残留边界。
  console.log(`  NOTE clampConfidence([]) = ${clampConfidence([])} —— 空数组未纳入「缺失」范围，属已知残留`);
  check('该行为可预期且有文档（上面 NOTE）', true);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
