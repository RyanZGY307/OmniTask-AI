// ================================================================
// 分段与分层策略（context compression）
//
// 任务书强制要求："待压缩历史超过压缩模型的输入容量时，必须优先采用分段压缩，
// 而不是直接删除大量历史内容" 且 "不能将 20 条消息 / 100 条消息或固定字节数
// 直接当作模型分段标准 —— 真正决定分段大小的是当前压缩模型一次请求能够
// 安全容纳的输入预算"。
//
// 本文件只做纯计算，不碰数据库、不调模型：因此可在任何环境测试。
// 输入是"带序号与 token 估算的消息列表"，输出是"带来源范围的分段计划"。
// ================================================================

import { estimateTokens } from './tokens';

export interface SegmentableMessage {
  seq: number;
  role: string;              // user | assistant | tool | system
  content: string;
  /** 同一 Agent 工具调用事件的组标识（assistant tool_call 与其 result 共享） */
  toolGroupId?: string | null;
  /** 是否工具调用/工具结果 */
  isToolCall?: boolean;
  isToolResult?: boolean;
  messageType?: string;
}

export interface PlannedSegment {
  index: number;
  startSeq: number;          // 含
  endSeq: number;            // 含
  messages: SegmentableMessage[];
  estimatedTokens: number;
  /** 因单条消息超预算而做内部切分时，记录切分点 */
  splitFromSingleMessage: boolean;
}

export interface SegmentationPlan {
  segments: PlannedSegment[];
  totalTokens: number;
  /** 是否需要分段（false = 可一次装入）*/
  needsSegmentation: boolean;
  /** 因单条消息超长而无法完整放入任何分段的消息（需引用式保留）*/
  oversizedMessages: SegmentableMessage[];
}

/** 分层记忆的时间远近（决定保留细节的密度，见任务书第六章） */
export type MemoryLayer = 'recent' | 'mid' | 'distant';

export interface LayerAssignment {
  seq: number;
  layer: MemoryLayer;
}

/**
 * 把连续的消息列表按分层策略标注远近。
 *
 * 采用"占压缩范围的比例"而非固定条数：一个 5 轮的对话不该被切成三层，
 * 而一个 3000 轮的对话三层都应该是实质性的。
 *
 * 下限保护（修复的缺陷）：消息数很少时（< MIN_MESSAGES_FOR_LAYERING），
 * 全部标为 recent。旧实现用纯相对比例，2 条消息也会产出 distant，
 * 导致分层策略把最近的内容误判为"久远历史"而过度压缩。
 */
export const MIN_MESSAGES_FOR_LAYERING = 8;

export function assignLayers(total: number, opts?: { recentRatio?: number; midRatio?: number }): MemoryLayer[] {
  const out: MemoryLayer[] = [];
  if (total <= 0) return out;
  // 短对话不分层：全部视为近期，避免误伤
  if (total < MIN_MESSAGES_FOR_LAYERING) {
    for (let i = 0; i < total; i++) out.push('recent');
    return out;
  }
  const recent = opts?.recentRatio ?? Number(process.env.MEMORY_LAYER_RECENT_RATIO ?? 0.25);
  const mid = opts?.midRatio ?? Number(process.env.MEMORY_LAYER_MID_RATIO ?? 0.35);
  for (let i = 0; i < total; i++) {
    const fromEnd = total - 1 - i;
    const rel = fromEnd / Math.max(1, total - 1);
    if (rel <= recent) out.push('recent');
    else if (rel <= recent + mid) out.push('mid');
    else out.push('distant');
  }
  return out;
}

/**
 * 分段计划。
 *
 * 边界优先级（任务书 5.3）：
 *   1. 完整用户-助手对话轮次
 *   2. 完整 Agent 工具调用及其对应结果（同 toolGroupId 不拆开）
 *   3. 完整任务阶段
 *   4. 完整的代码块/文档段落（由上层保证消息内聚，这里不拆消息内部）
 *   5. 万不得已才对超长单条消息做内部切分（记录来源，绝不丢弃后半段）
 *
 * 关键性质：**在发起调用前**就确定边界，且每段 estimatedTokens 都 ≤ budget。
 */
export function planSegments(
  messages: SegmentableMessage[],
  segmentBudgetTokens: number,
  opts?: { overlapMessages?: number },
): SegmentationPlan {
  const overlap = opts?.overlapMessages ?? 1;   // 段间保留少量背景，合并时去重
  const tokens = messages.map((m) => estimateTokens(m.content) + 8 /* role/元数据开销 */);
  const totalTokens = tokens.reduce((a, b) => a + b, 0);

  // 只要装得下就不分段 —— 任务书："待压缩历史能够安全放入一次压缩请求时，
  // 正常使用适当的压缩流程"
  const fitsSingle = totalTokens <= segmentBudgetTokens;
  if (fitsSingle) {
    return {
      segments: [{
        index: 0,
        startSeq: messages[0]?.seq ?? 0,
        endSeq: messages[messages.length - 1]?.seq ?? 0,
        messages,
        estimatedTokens: totalTokens,
        splitFromSingleMessage: false,
      }],
      totalTokens,
      needsSegmentation: false,
      oversizedMessages: [],
    };
  }

  const segments: PlannedSegment[] = [];
  const oversized: SegmentableMessage[] = [];
  let cur: SegmentableMessage[] = [];
  let curTokens = 0;
  let i = 0;
  let idx = 0;

  // 工具组不能跨段：先算出每组最后一条的下标
  const lastIndexOfGroup = new Map<string, number>();
  messages.forEach((m, n) => {
    if (m.toolGroupId) lastIndexOfGroup.set(m.toolGroupId, n);
  });

  while (i < messages.length) {
    const m = messages[i];
    const t = tokens[i];

    // 单条就超预算：不能塞进任何分段，也不能丢弃 → 标记为需引用式保留
    if (t > segmentBudgetTokens) {
      oversized.push(m);
      i++;
      continue;
    }

    // 工具调用组：把整组一起纳入（即使略超预算也不能拆开关联）
    let take: SegmentableMessage[] = [];
    let takeTokens = 0;
    if (m.toolGroupId) {
      const end = lastIndexOfGroup.get(m.toolGroupId)!;
      for (let n = i; n <= end; n++) {
        // 组本身超预算：整组只能引用式保留，不能拆
        if (takeTokens + tokens[n] > segmentBudgetTokens) {
          for (let k = i; k <= end; k++) oversized.push(messages[k]);
          take = [];
          break;
        }
        take.push(messages[n]);
        takeTokens += tokens[n];
      }
      if (take.length === 0) { i = end + 1; continue; }
      i = end + 1;
    } else {
      if (curTokens + t > segmentBudgetTokens) {
        // 关闭当前段
        segments.push({
          index: idx++,
          startSeq: cur[0].seq,
          endSeq: cur[cur.length - 1].seq,
          messages: cur,
          estimatedTokens: curTokens,
          splitFromSingleMessage: false,
        });
        // 段间重叠：把上段最后若干条作为下一段背景（合并时去重）。
        // 修复的缺陷：旧实现直接 slice(-overlap)，可能把一个工具调用组的
        // call 留在上一段、result 带进下一段，破坏工具调用与结果的协议关联
        // （任务书 11.2 明令禁止）。因此重叠尾部必须回退到完整工具组边界。
        let tail = overlap > 0 ? cur.slice(-overlap) : [];
        const lastGroupInTail = tail.find((x) => x.toolGroupId)?.toolGroupId;
        if (lastGroupInTail) {
          // 找到该组在 cur 中的第一条；若它不在 tail 内，说明 tail 切开了组 → 整组带入
          const firstIdx = cur.findIndex((x) => x.toolGroupId === lastGroupInTail);
          if (firstIdx >= 0 && firstIdx < cur.length - tail.length) {
            tail = cur.slice(firstIdx);
          }
        }
        cur = [...tail, m];
        curTokens = tail.reduce((a, x) => a + estimateTokens(x.content) + 8, 0) + t;
      } else {
        cur.push(m);
        curTokens += t;
      }
      i++;
      continue;
    }

    // 工具组作为独立分段起点
    if (cur.length > 0) {
      segments.push({
        index: idx++,
        startSeq: cur[0].seq,
        endSeq: cur[cur.length - 1].seq,
        messages: cur,
        estimatedTokens: curTokens,
        splitFromSingleMessage: false,
      });
      cur = [];
      curTokens = 0;
    }
    segments.push({
      index: idx++,
      startSeq: take[0].seq,
      endSeq: take[take.length - 1].seq,
      messages: take,
      estimatedTokens: takeTokens,
      splitFromSingleMessage: false,
    });
  }

  if (cur.length > 0) {
    segments.push({
      index: idx++,
      startSeq: cur[0].seq,
      endSeq: cur[cur.length - 1].seq,
      messages: cur,
      estimatedTokens: curTokens,
      splitFromSingleMessage: false,
    });
  }

  return { segments, totalTokens, needsSegmentation: true, oversizedMessages: oversized };
}

/**
 * 多级合并的分组计划。
 *
 * 任务书 5.7："如果局部摘要的总长度仍然超过模型上下文容量，必须继续采用
 * 分层合并机制 —— 第一层原始分段、第二层摘要分组、第三层级摘要、第四层
 * 最终累积摘要。禁止通过不断缩短摘要伪装分段合并已成功。"
 *
 * 本函数只回答一个问题：给定一批摘要的 token 数与本次可用的预算，
 * 应该分几组、每组装哪些。
 */
export interface GroupableItem {
  /** 项的标识。调用方用其在原数组中的下标即可（不必是字符串）。 */
  id: string | number;
  tokens: number;
}

export function planMergeGroups(items: GroupableItem[], groupBudgetTokens: number): GroupableItem[][] {
  const groups: GroupableItem[][] = [];
  let cur: GroupableItem[] = [];
  let curTokens = 0;
  for (const it of items) {
    if (it.tokens > groupBudgetTokens) {
      // 单项就超预算：单独成组（上层必须已保证单项不超预算）
      if (cur.length) { groups.push(cur); cur = []; curTokens = 0; }
      groups.push([it]);
      continue;
    }
    if (curTokens + it.tokens > groupBudgetTokens) {
      groups.push(cur);
      cur = [it];
      curTokens = it.tokens;
    } else {
      cur.push(it);
      curTokens += it.tokens;
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// ================================================================
// 单条消息本身超过压缩模型输入预算时的结构化分块（任务书 5.11）
//
// 触发条件不是"整段历史太长"，而是**单条**用户消息、助手消息、文件文本、
// 代码块或工具返回结果本身就超过单次压缩请求能安全容纳的量。
//
// 优先顺序（严格按任务书 5.11 的 1→6）：
//   1. 独立文件/附件 → 保留原始资源与稳定引用，解析为有顺序小块
//   2. 长篇纯文本    → 按段落/标题/主题/语义边界分块
//   3. 代码          → 按文件/类/函数/模块/语法结构划分，保留路径与位置
//   4. 大型结构化结果 → 保留可验证关键字段、必要记录与原始结果引用
//   5. 日志/重复内容  → 去重或提取主要错误与关键事件，但不删故障判断上下文
//   6. 多模态         → 按项目实际能力处理（本处只保证不丢弃引用）
//
// 硬约束：
//   - 必须维护原始消息 ID、片段序号、来源位置及重组关系
//   - 分块之间保留足够信息使各片段可被正确理解
//   - **不能只保留开头或结尾，不能直接删除整个消息**
//   - 逐字准确还原的内容必须保留原文或可信引用，不只依赖模型摘要
// ================================================================

export interface OversizedChunk {
  /** 原始消息的 seq（重组与溯源依据） */
  sourceSeq: number;
  /** 片段序号（1..N，同一条消息内唯一） */
  chunkIndex: number;
  /** 片段总数 */
  chunkTotal: number;
  /** 来源定位：字符区间 / 代码结构名 / 字段路径 */
  sourceSpan: string;
  /** 内容类型（决定采用哪种分块策略） */
  kind: 'text' | 'code' | 'structured' | 'log' | 'multimodal' | 'unknown';
  content: string;
}

/** 判定单条内容的结构类型（决定分块策略）。 */
export function classifyContent(content: string): OversizedChunk['kind'] {
  const head = content.slice(0, 400);
  // 结构化：JSON / JSON 数组 / 明显表格
  if (/^\s*[[{]/.test(content) && /["}\]\n]/.test(content.slice(-400))) {
    try { JSON.parse(content); return 'structured'; } catch { /* not json */ }
  }
  // 代码：常见语法特征（import/function/class/def/#include/括号块）
  if (/^\s*(import |from |require\(|function |class |def |const |let |var |#include|package )/m.test(content)
      || /```/.test(content)) return 'code';
  // 日志：时间戳 + 级别词
  if (/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(content) && /\b(ERROR|WARN|INFO|DEBUG|error|warn)\b/.test(content)) return 'log';
  // 多模态：本项目消息以文本承载，URL/路径引用视为需保留引用
  if (/^\s*(https?:\/\/|\/)/.test(head) && content.length > 2000) return 'multimodal';
  return 'text';
}

/** 按内容类型选择分块边界。返回的每个块都带来源定位。 */
function splitByStructure(content: string, kind: OversizedChunk['kind'], budget: number): Array<{ span: string; text: string }> {
  if (kind === 'code') {
    // 3) 代码：按顶层结构（函数/类/export 块）划分，保留路径与位置信息
    const lines = content.split('\n');
    const units: Array<{ start: number; end: number }> = [];
    let cur = 0;
    for (let i = 1; i < lines.length; i++) {
      if (/^(export\s+)?(async\s+)?(function|class|def|const|let|var)\s|^(class|def|#include|package)\s|^}\s*$/.test(lines[i])) {
        units.push({ start: cur, end: i });
        cur = i;
      }
    }
    if (cur < lines.length) units.push({ start: cur, end: lines.length });
    const out: Array<{ span: string; text: string }> = [];
    let buf: string[] = [];
    let bufStart = 0;
    for (const u of units) {
      const seg = lines.slice(u.start, u.end).join('\n');
      if (seg.length > budget && buf.length > 0) {
        out.push({ span: `L${bufStart + 1}-L${u.start}`, text: buf.join('\n') });
        buf = [];
        bufStart = u.end;
      }
      buf.push(seg);
      if (buf.join('\n').length >= budget) {
        out.push({ span: `L${bufStart + 1}-L${u.end}`, text: buf.join('\n') });
        buf = [];
        bufStart = u.end;
      }
    }
    if (buf.length) out.push({ span: `L${bufStart + 1}-L${lines.length}`, text: buf.join('\n') });
    return out.filter((u) => u.text.trim().length > 0);
  }

  if (kind === 'structured') {
    // 4) 大型结构化结果：按顶层键/数组元素切分，保留可验证关键字段
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const out: Array<{ span: string; text: string }> = [];
        let batch: any[] = [];
        let startIdx = 0;
        const flush = (endIdx: number) => {
          out.push({ span: `items[${startIdx}..${endIdx}]`, text: JSON.stringify(batch) });
          batch = [];
        };
        for (let i = 0; i < parsed.length; i++) {
          batch.push(parsed[i]);
          if (JSON.stringify(batch).length >= budget) { flush(i); startIdx = i + 1; }
        }
        if (batch.length) flush(parsed.length - 1);
        return out.length ? out : [{ span: 'root', text: content }];
      }
    } catch { /* fall through to text */ }
  }

  if (kind === 'log') {
    // 5) 日志：按时间戳行分块，错误行强制随同块保留（不删故障判断上下文）
    const lines = content.split('\n');
    const out: Array<{ span: string; text: string }> = [];
    let buf: string[] = [];
    let startLine = 1;
    for (let i = 0; i < lines.length; i++) {
      buf.push(lines[i]);
      const isErr = /\b(ERROR|FATAL|error|failed|exception|traceback)\b/i.test(lines[i]);
      // 错误行及其后 3 行上下文必须与当前块一起，不得跨块丢失
      if (buf.join('\n').length >= budget && !isErr && !lines.slice(i, i + 3).some((l) => /\b(error|fail|exception)\b/i.test(l))) {
        out.push({ span: `L${startLine}-L${i + 1}`, text: buf.join('\n') });
        buf = [];
        startLine = i + 2;
      }
    }
    if (buf.length) out.push({ span: `L${startLine}-L${lines.length}`, text: buf.join('\n') });
    return out.filter((u) => u.text.trim().length > 0);
  }

  // 2) 长篇纯文本：按空行分段（段落/章节边界），保留顺序与重叠上下文
  const paras = content.split(/\n\s*\n/);
  const out: Array<{ span: string; text: string }> = [];
  let buf: string[] = [];
  let startP = 0;
  for (let i = 0; i < paras.length; i++) {
    buf.push(paras[i]);
    if (buf.join('\n\n').length >= budget) {
      out.push({ span: `P${startP + 1}-P${i + 1}`, text: buf.join('\n\n') });
      buf = [];
      startP = i + 1;
    }
  }
  if (buf.length) out.push({ span: `P${startP + 1}-P${paras.length}`, text: buf.join('\n\n') });
  return out.filter((u) => u.text.trim().length > 0);
}

/**
 * 把超长单条消息切成可安全进入压缩请求的块。
 * 返回的块按原始顺序排列；拼回 join('') 之外的语义由 sourceSpan 描述。
 * 保留原文引用：调用方应同时保存原始内容（不入库删除前的保护）。
 */
export function splitOversizedMessage(
  msg: { seq: number; content: string },
  budgetTokens: number,
): OversizedChunk[] {
  // Token 预算换算为字符预算（与 tokens.ts 同一保守系数，略保守）
  const charBudget = Math.max(2000, Math.floor(budgetTokens * 1.9));
  const kind = classifyContent(msg.content);
  const units = splitByStructure(msg.content, kind, charBudget);

  // ===== 绝对不变量：任何输出块都不得超过字符预算 =====
  // 修复的真实缺陷：按段落/结构切分时，若内容本身没有可用边界
  //（例如一整行 20 万字符、无空行、无代码结构），splitByStructure 会返回
  // 单个超大块。原先的硬切兜底只在 units.length === 0 时触发，因此永远不
  // 生效，超长块会被直接送给模型 —— 正是任务书 5.2 禁止的
  // "先构造一个超出模型容量的超长请求"。
  // 现在对**每一个**超预算的单元统一做字符硬切（首尾都保留，绝不只留一头）。
  const normalized: Array<{ span: string; text: string }> = [];
  for (const u of units) {
    if (u.text.length <= charBudget) { normalized.push(u); continue; }
    for (let i = 0; i < u.text.length; i += charBudget) {
      const piece = u.text.slice(i, Math.min(i + charBudget, u.text.length));
      normalized.push({
        span: `${u.span} [字符硬切 ${i}-${Math.min(i + charBudget, u.text.length)}]`,
        text: piece,
      });
    }
  }

  // 连一个结构单元都切不出来时（units 为空），整体硬切
  const final = normalized.length > 0 ? normalized : (() => {
    const hard: Array<{ span: string; text: string }> = [];
    for (let i = 0; i < msg.content.length; i += charBudget) {
      hard.push({ span: `chars${i}-${Math.min(i + charBudget, msg.content.length)}`, text: msg.content.slice(i, i + charBudget) });
    }
    return hard;
  })();

  return final.map((u, n) => ({
    sourceSeq: msg.seq, chunkIndex: n + 1, chunkTotal: final.length,
    sourceSpan: u.span, kind, content: u.text,
  }));
}

/** 需要多少层合并才能使总计 token 降到预算内（防止无限合并） */
export function mergeDepthEstimate(totalTokens: number, groupBudgetTokens: number): number {
  if (totalTokens <= groupBudgetTokens) return 0;
  let level = 0;
  let size = totalTokens;
  // 每层压缩保守假设降到 40%（摘要比原文短，但不假设 1/10 这种乐观值）
  while (size > groupBudgetTokens && level < 12) {
    size = Math.ceil(size * 0.4);
    level++;
  }
  return level;
}
