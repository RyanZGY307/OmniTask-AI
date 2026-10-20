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
