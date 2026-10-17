// ================================================================
// Sensitive Guard — 用户消息敏感度分级 / 警告计数 / 拒绝与标记落档
// 分级规则与既有政治中立检查互补：政治内容保持中立回答，不进入标记；
// 本模块只管高/中敏感内容（违法违规、成瘾自伤、未成年色情等）。
// 检测完全基于规则表，不加新的 LLM 调用（无额外模型开销，避免误判由模型自由裁定）。
//
// 设计要点（对应敏感度处理规则）：
// - 高敏感：直接拒绝，不经过警告流程，落档最近 5 对消息；
// - 中敏感：同一「受限事项」最多 3 次警告，第 4 次起拒绝，落档最近 10 对消息；
// - 警告次数按「该会话内同一标签集合的历史出现次数」推导（存于 assistant
//   消息 metadata.safetyTopics），无关话题不会继承计数，也不依赖内存计数器；
// - 落档用 sourceMessageId 去重（同一触发消息重试只落一条）；
// - 落档失败不影响拒绝回答，只把 uploadStatus 标为 failed；
// - 落档数据有保留期（默认 180 天，SAFETY_FLAG_RETENTION_DAYS）。
// ================================================================

import { prismaConversation } from './db';

export type SensitivityLevel = 'none' | 'medium' | 'high';

export interface SensitivityVerdict {
  level: SensitivityLevel;
  labels: string[]; // 命中的敏感分类标签，随 FlaggedConversation.reason 入档
}

export const MAX_MEDIUM_WARNINGS = 3; // 中高敏感：3 次警告后拒绝
export const HIGH_UPLOAD_PAIRS = 5;   // 高敏感直拒：上传最近 5 对消息
export const EXHAUSTED_UPLOAD_PAIRS = 10; // 中高敏感警告耗尽：上传最近 10 对消息
export const SAFETY_WARNING_LIMIT = MAX_MEDIUM_WARNINGS;

/** 落档数据保留天数（到期由 cleanupExpiredFlags 删除） */
export const SAFETY_FLAG_RETENTION_DAYS = Number(process.env.SAFETY_FLAG_RETENTION_DAYS || 180);

const HIGH_RULES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /制毒|制造毒品|毒品合成|合成冰毒|冰毒配方|摇头丸制作|大麻种植|提炼毒品/i, label: '违禁品制作' },
  { pattern: /制造爆炸物|制爆|炸药配方|雷管制作|简易爆炸装置|土制炸弹/i, label: '爆炸物制作' },
  { pattern: /恐怖袭击策划|人肉炸弹|汽车袭击|无差别攻击|暴力袭击计划/i, label: '恐怖袭击' },
  { pattern: /自杀教程|自杀方法|如何自杀|教你自杀|烧炭自杀|上吊方法|跳楼自杀/i, label: '自伤自杀指导' },
  { pattern: /儿童色情|幼女裸体|未成年色情|儿童性影像/i, label: '未成年色情' },
  { pattern: /bomb making|make a bomb|explosive recipe|synthesize meth|child porn/i, label: 'prohibited-content' },
];

const MEDIUM_RULES: Array<{ pattern: RegExp; label: string }> = [
  // 暴力/自伤倾向（非指导级）
  { pattern: /想自杀|好想死|活着没意思|自残|自伤|报复社会|想绑架|想杀人|恨死.*所以杀/i, label: '心理危机/暴力倾向' },
  { pattern: /暴力视频|血腥视频|猎奇视频|gore|斩首视频/i, label: '暴恐视听' },
  // 违禁品交易
  { pattern: /买枪|枪支买卖|仿真枪|气枪|管制刀具|买毒品|买迷药|买安眠药/i, label: '违禁交易' },
  // 低俗/色情
  { pattern: /淫秽小说|色情小说|色情网站|裸聊|约炮|性服务|嫖娼/i, label: '低俗色情' },
  // 涉赌涉诈、规避监管
  { pattern: /赌博网站|赌球|六合彩|网络赌博|洗钱|资金盘|跑分|套现|诈骗话术|电信诈骗|帮信/i, label: '赌博诈骗' },
  // 邪教
  { pattern: /邪教|法轮功|gong效组织/i, label: '邪教组织' },
  { pattern: /drug deal|buy gun|escort serv|gambling site|laundering/i, label: 'restricted-trade' },
];

// 求助/关怀语境：本人或他人处于危机、寻求帮助或需要预防与干预，
// 属于应正常帮助的安全范围，不按「心理危机/暴力倾向」计警告。
const BENIGN_HELP_CONTEXT =
  /怎么办|如何帮(助|他|她)|如何安慰|怎么劝|如何预防|怎么预防|预防自杀|求助|寻求帮助|心理援助|心理热线|危机干预|安抚|支持ta|预防措施|自我保护|报警|how to help|how to prevent|seek help|helpline|hotline|prevent suicide/i;

// 教育/研究/新闻/法律语境：正常科普、新闻讨论与法律咨询不应因出现
// 敏感主题词就被一刀切警告；只对「非指导级」的中敏感标签生效。
const EDU_CONTEXT =
  /科普|预防|防范|研究|学术|论文|新闻报道|新闻里|报道|法律咨询|法律条文|立法|判例|政策|统计|纪录片|history|news|research|education|academic|legal advice|prevention/i;

/** 求助语境可豁免的中敏感标签（避免误伤危机求助者） */
const HELP_EXEMPT_LABELS = new Set(['心理危机/暴力倾向']);
/** 教育语境可豁免的中敏感标签（高危制作类不豁免，且高敏感永不豁免） */
const EDU_EXEMPT_LABELS = new Set(['暴恐视听', '违禁交易', '低俗色情', '赌博诈骗', '邪教组织', 'restricted-trade']);

/** 规则判定。高 > 中；无命中返回 none。reason 用于入档，不进提示词。 */
export function evaluateSensitivity(message: string): SensitivityVerdict {
  const highLabels: string[] = [];
  for (const { pattern, label } of HIGH_RULES) if (pattern.test(message)) highLabels.push(label);
  if (highLabels.length > 0) return { level: 'high', labels: highLabels };

  const helpContext = BENIGN_HELP_CONTEXT.test(message);
  const eduContext = EDU_CONTEXT.test(message);

  const labels: string[] = [];
  for (const { pattern, label } of MEDIUM_RULES) {
    if (!pattern.test(message)) continue;
    if (helpContext && HELP_EXEMPT_LABELS.has(label)) continue;
    if (eduContext && EDU_EXEMPT_LABELS.has(label)) continue;
    labels.push(label);
  }
  if (labels.length > 0) return { level: 'medium', labels };

  return { level: 'none', labels: [] };
}

export const REFUSAL_TEXT_HIGH =
  '抱歉，这个问题涉及高敏感内容，我无法回答。请遵守平台使用规范。';

export const REFUSAL_TEXT_MEDIUM_EXHAUSTED =
  `抱歉，该话题已多次被识别为敏感内容，本次不再回答。`;

export function buildWarningText(warningCount: number): string {
  return `⚠️ 此内容涉及中-高敏感话题，这是第 ${warningCount} 次警告（3 次后将拒绝回答）。`;
}

export interface FlaggedSnapshotPair { role: string; content: string; }

function intersects(a: string[], b: string[]): boolean {
  for (const x of a) if (b.includes(x)) return true;
  return false;
}

/**
 * 纯函数：给定「历史每次命中的标签集合」，返回与本次标签同一受限事项的次数。
 * 便于单测，不涉及数据库。
 */
export function countTopicOccurrences(history: string[][], topics: string[]): number {
  if (topics.length === 0) return 0;
  let n = 0;
  for (const record of history) if (intersects(record, topics)) n++;
  return n;
}

/** 会话上保存的受限事项历史（每次命中一个标签数组），仅保留最近 50 次 */
const MAX_TOPIC_HISTORY = 50;

export function parseTopicHistory(raw: unknown): string[][] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(Array.isArray).map((row: unknown[]) => row.filter((x): x is string => typeof x === 'string'));
  } catch {
    return [];
  }
}

/**
 * 登记一次同一「受限事项」的出现，返回本次是该事项的第几次。
 * - 事务 + Postgres 顾问锁（按 conversationId）：并发请求不会丢计数或绕过阀值；
 * - 只累计与本次标签有交集的旧记录，无关话题不会继承计数；
 * - 计数持久化在 Conversation.safetyTopicHistory，与进程重启/刷新无关。
 */
export async function registerTopicOccurrence(conversationId: string, topics: string[]): Promise<number> {
  try {
    return await prismaConversation.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${conversationId}))`;
      const conv = await tx.conversation.findUnique({
        where: { id: conversationId },
        select: { safetyTopicHistory: true },
      });
      const history = parseTopicHistory(conv?.safetyTopicHistory);
      const occurrence = countTopicOccurrences(history, topics) + 1;
      history.push(topics);
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          safetyTopicHistory: JSON.stringify(history.slice(-MAX_TOPIC_HISTORY)),
          safetyWarnings: { increment: 1 },
        },
      });
      return occurrence;
    });
  } catch (err: any) {
    // 计数登记失败时保守返回 1（不因技术故障把用户当成已多次违规）
    console.warn('[SafetyGate] registerTopicOccurrence failed:', err?.message ?? err);
    return 1;
  }
}

// ==================== 拒绝与落档 ====================

export interface SafetyRefusalResult {
  conversation: any;
  refusalMessage: any;
  flagRow: any | null;
  uploadStatus: 'pending' | 'ok' | 'failed';
  deduped: boolean;
}

/**
 * 拒绝回答并落档：
 * 1. 若无会话先建会话（新对话路径）；
 * 2. 事务内写入用户消息 + 快照 + 会话标记 + 拒答消息（uploadStatus=pending）；
 * 3. 事务外写 FlaggedConversation（失败不影响拒绝），再回填真实提交状态；
 * 4. 同一触发消息重复进入时按 sourceMessageId 去重，不产生重复落档。
 */
export async function issueSafetyRefusal(opts: {
  userId: string;
  username: string;
  conversation: any | null; // 已有会话或 null（新对话）
  message: string;
  level: Exclude<SensitivityLevel, 'none'>; // 'high' 直拒 | 'medium'（警告耗尽）
  labels: string[];
  warningCount: number;
  model?: string | null;
  sourceMessageId?: string | null; // 触发本次标记的用户消息 id（幂等键）
}): Promise<SafetyRefusalResult> {
  const conv = opts.conversation ?? await prismaConversation.conversation.create({
    data: { userId: opts.userId, title: opts.message.substring(0, 50) },
  });

  // 幂等：同一触发消息已经落过档 → 直接返回既有拒答消息，不重复写
  if (opts.sourceMessageId) {
    const existingRow = await prismaConversation.flaggedConversation.findFirst({
      where: { sourceMessageId: opts.sourceMessageId },
    });
    if (existingRow) {
      const prevMsg = await prismaConversation.message.findFirst({
        where: { conversationId: conv.id, metadata: { contains: 'safetyFlag' } },
        orderBy: { createdAt: 'desc' },
      });
      if (prevMsg) {
        return {
          conversation: conv,
          refusalMessage: prevMsg,
          flagRow: existingRow,
          uploadStatus: (existingRow.uploadStatus as any) || 'ok',
          deduped: true,
        };
      }
    }
  }

  const pairs = opts.level === 'high' ? HIGH_UPLOAD_PAIRS : EXHAUSTED_UPLOAD_PAIRS;
  const refusalText = opts.level === 'high' ? REFUSAL_TEXT_HIGH : REFUSAL_TEXT_MEDIUM_EXHAUSTED;
  const topics = opts.labels;

  // 事务：用户消息 + 快照 + 会话标记 + 拒答消息（pending）原子写入
  const { refusalMsg, snapshot, userMsgId } = await prismaConversation.$transaction(async (tx) => {
    const userMsg = await tx.message.create({
      data: { conversationId: conv.id, role: 'user', content: opts.message, messageType: 'text' },
    });
    const recent = await tx.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'desc' },
      take: pairs * 2,
    });
    const snap: FlaggedSnapshotPair[] = recent.reverse().map((m: any) => ({ role: m.role, content: m.content }));
    await tx.conversation.update({
      where: { id: conv.id },
      data: { isSafetyFlagged: true, safetyWarnings: opts.warningCount },
    });
    const msg = await tx.message.create({
      data: {
        conversationId: conv.id,
        role: 'assistant',
        content: refusalText,
        messageType: 'text',
        model: opts.model || undefined,
        metadata: JSON.stringify({
          safetyFlag: { level: opts.level, uploadedPairs: pairs, uploadStatus: 'pending' },
          safetyTopics: topics,
        }),
      },
    });
    return { refusalMsg: msg, snapshot: snap, userMsgId: userMsg.id };
  });

  // 幂等键：优先用调用方传入的触发标识；缺失时用本次写入的用户消息 id，
  // 保证唯一约束真实生效（同一记录不会因重试重复落档）。
  const sourceMessageId = opts.sourceMessageId || userMsgId;

  let flagRow: any | null = null;
  let uploadStatus: 'ok' | 'failed' = 'ok';
  try {
    flagRow = await prismaConversation.flaggedConversation.create({
      data: {
        userId: opts.userId,
        username: opts.username,
        conversationId: conv.id,
        level: opts.level,
        reason: opts.labels.join(',') || undefined,
        model: opts.model || undefined,
        warningCount: opts.warningCount,
        uploadedPairs: pairs,
        messagesJson: JSON.stringify(snapshot),
        sourceMessageId,
        topics: opts.labels.join(',') || undefined,
        uploadStatus: 'ok',
        retentionUntil: new Date(Date.now() + SAFETY_FLAG_RETENTION_DAYS * 24 * 3600 * 1000),
      },
    });
  } catch (err: any) {
    // 落档失败不能撤销拒绝本身；仅记录真实提交状态
    uploadStatus = 'failed';
    console.error('[SafetyGate] flag record write failed:', err?.message ?? err);
  }

  // 回填真实提交状态（前端据此显示“正在上传/已上传/上传失败”）
  let finalMsg = refusalMsg;
  try {
    finalMsg = await prismaConversation.message.update({
      where: { id: refusalMsg.id },
      data: {
        metadata: JSON.stringify({
          safetyFlag: { level: opts.level, uploadedPairs: pairs, uploadStatus },
          safetyTopics: topics,
        }),
      },
    });
  } catch (err: any) {
    console.warn('[SafetyGate] refusal metadata update failed:', err?.message ?? err);
  }

  return { conversation: conv, refusalMessage: finalMsg, flagRow, uploadStatus, deduped: false };
}

/**
 * 中敏感警告：只增加会话级展示计数（原子自增，供管理端查看）。
 * 判定用的次数来自 deriveTopicWarnings（按同一受限事项），
 * 因此本计数仅作审计展示，不参与是否拒绝的决策。
 */
export async function recordMediumWarning(conversationId: string): Promise<void> {
  try {
    await prismaConversation.conversation.update({
      where: { id: conversationId },
      data: { safetyWarnings: { increment: 1 } },
    });
  } catch (err: any) {
    console.warn('[SafetyGate] recordMediumWarning failed:', err?.message ?? err);
  }
}

/**
 * 保留期清理：删除已过 retentionUntil 的落档记录。
 * 返回删除条数。由启动后的定时任务调用（默认每天一次）。
 */
export async function cleanupExpiredFlags(): Promise<number> {
  try {
    const res = await prismaConversation.flaggedConversation.deleteMany({
      where: { retentionUntil: { not: null, lt: new Date() } },
    });
    return res.count;
  } catch (err: any) {
    console.warn('[SafetyGate] cleanupExpiredFlags failed:', err?.message ?? err);
    return 0;
  }
}
