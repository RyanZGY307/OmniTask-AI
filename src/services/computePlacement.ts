// ================================================================
// 计算下沉（compute offload）— 放置策略纯逻辑层
// ================================================================
// 需求：「把计算量高的部分放前端，占用用户 CPU；只留计算量轻的在后端」。
//
// 本文件把「什么能下沉、什么绝不能下沉」编码成**可测试的规则**，
// 而不是散落在文档里的口头约定。UI/接入方必须调用 classify() 拿结论，
// 不允许自行判断。
//
// 四条硬规则（安全优先，按优先级从上到下）：
//   R1 触及供应商 API key 的计算 → 必须留服务端。
//       浏览器一旦持有可用 key，任何 XSS/恶意扩展即可盗用并刷额度，
//       且平台钱包直接受损。
//   R2 属于信任边界的计算（鉴权、计费扣款、审计留痕、越权校验）
//        → 必须留服务端。客户端结果一律不可信。
//   R3 需要跨用户聚合 / 服务自己不知道的数据 → 必须留服务端。
//   R4 其余：**输入全部来自客户端已合法持有的数据、输出只回给该用户
//      自己** → 可以下沉，但必须声明降级路径（低端机/小内存/关 JS）。
//
// 关键：本层只回答「放哪」，不改变任何现有服务端逻辑。
// 接入方按 verdict 决定实现位置，fallback 必须真实可用。
// ================================================================

export type Verdict = 'server' | 'client' | 'client-with-fallback';

/** 计算任务描述（接入方按实际代码填写）。 */
export interface ComputeTask {
  /** 稳定标识，用于日志与测试断言 */
  id: string;
  /** 人读名称 */
  label: string;
  /** 所属分类 */
  category:
    | 'ai-call'          // 调 LLM/嵌入/重排
    | 'embedding'        // 向量化
    | 'auth'             // 鉴权/会话
    | 'billing'          // 计费/扣款/额度
    | 'audit'            // 审计留痕
    | 'db-write'         // 写库
    | 'aggregate'        // 跨用户统计
    | 'transform'        // 纯变换（排序/过滤/格式化/分词估算）
    | 'render'           // 渲染层计算（markdown/高亮）
    | 'docgen'           // 文档生成 PDF/Office/Excel
    | 'media'            // 图片/音视频处理
    | 'crypto';          // 加解密/哈希
  /**
   * 是否需要持有机密（provider key / 内部 token / 数据库口令）。
   * **true ⇒ 一律服务端**，与其它字段无关。
   */
  needsSecret: boolean;
  /** 输入是否全部来自该用户已合法持有的数据 */
  clientOnlyInput: boolean;
  /** 输出是否只回给该用户自己（不跨用户可见） */
  outputScopedToUser: boolean;
  /** 相对计算量（1 轻 - 5 重），用于「重的优先下沉」 */
  weight: 1 | 2 | 3 | 4 | 5;
  /** 是否有可用的降级路径（Web Worker / 降精度 / 同步执行） */
  hasFallback: boolean;
}

export interface PlacementDecision {
  verdict: Verdict;
  /** 触发的规则编号，便于审计与出错时定位 */
  rule: 'R1-secret' | 'R2-trust-boundary' | 'R3-aggregation' | 'R4-offload';
  /** 给人读的理由（写入实施报告/日志） */
  reason: string;
}

/**
 * 判定计算任务放哪。纯函数，可完整单测。
 * 顺序即优先级：**先排除绝不能下沉的，再判断能下沉的**。
 */
export function classify(task: ComputeTask): PlacementDecision {
  // ---- R1 机密：最高优先级，一票否决 ----
  if (task.needsSecret) {
    return {
      verdict: 'server', rule: 'R1-secret',
      reason: '需要持有供应商 API key / 内部机密：下沉会把可用凭据放进浏览器，',
    };
  }
  // R1 附带：这些品类天然带机密或属于信任边界，即使漏填 needsSecret 也拦
  const SENSITIVE: ComputeTask['category'][] = ['ai-call', 'embedding', 'auth', 'billing', 'audit', 'crypto'];
  if (SENSITIVE.includes(task.category)) {
    return {
      verdict: 'server', rule: 'R1-secret',
      reason: `品类 ${task.category} 涉及供应商凭据或信任边界（即使未显式声明 needsSecret）`,
    };
  }

  // ---- R2 信任边界 ----
  const TRUST: ComputeTask['category'][] = ['billing', 'audit', 'db-write', 'auth'];
  if (TRUST.includes(task.category)) {
    return {
      verdict: 'server', rule: 'R2-trust-boundary',
      reason: `品类 ${task.category} 属于信任边界，客户端结果一律不可信`,
    };
  }

  // ---- R3 跨用户 / 服务端持有 ----
  if (task.category === 'aggregate' || !task.clientOnlyInput) {
    return {
      verdict: 'server', rule: 'R3-aggregation',
      reason: task.category === 'aggregate'
        ? '跨用户聚合需要服务端全量数据，客户端无法获得'
        : '输入并非全部来自客户端已合法持有的数据',
    };
  }

  // ---- R4 可下沉 ----
  if (!task.outputScopedToUser) {
    return {
      verdict: 'server', rule: 'R3-aggregation',
      reason: '输出会跨用户可见，不能由不可信客户端计算',
    };
  }

  // 轻量任务下沉收益低，且会拖慢首屏 → 留服务端
  if (task.weight <= 2) {
    return {
      verdict: 'server', rule: 'R4-offload',
      reason: `计算量轻（weight=${task.weight}）：下沉收益低于网络与序列化开销`,
    };
  }

  if (!task.hasFallback) {
    return {
      verdict: 'client-with-fallback', rule: 'R4-offload',
      reason: '未声明降级路径：下沉前必须先提供低端机可用的 fallback',
    };
  }

  return {
    verdict: 'client', rule: 'R4-offload',
    reason: `计算量重（weight=${task.weight}）且输入/输出均限于该用户，适合下沉`,
  };
}

// ==================== 平台既有计算的归类结论 ====================
// 这些是**按本平台真实代码结构**给出的结论，供实施报告引用。
// 每一条都可被 classify() 复算，不允许与规则冲突。
export const PLATFORM_TASKS: ComputeTask[] = [
  {
    id: 'ai.chat', label: '对话 LLM 调用', category: 'ai-call', weight: 5,
    needsSecret: true, clientOnlyInput: true, outputScopedToUser: true, hasFallback: false,
  },
  {
    id: 'ai.embedding', label: '向量嵌入', category: 'embedding', weight: 4,
    needsSecret: true, clientOnlyInput: true, outputScopedToUser: false, hasFallback: false,
  },
  {
    id: 'ai.rerank', label: '检索重排', category: 'ai-call', weight: 4,
    needsSecret: true, clientOnlyInput: true, outputScopedToUser: true, hasFallback: false,
  },
  {
    id: 'auth.jwt.verify', label: 'JWT 校验 / 会话', category: 'auth', weight: 1,
    needsSecret: true, clientOnlyInput: false, outputScopedToUser: false, hasFallback: false,
  },
  {
    id: 'billing.deduct', label: '积分扣减', category: 'billing', weight: 2,
    needsSecret: true, clientOnlyInput: true, outputScopedToUser: false, hasFallback: false,
  },
  {
    id: 'billing.preview', label: '本次请求积分预估（仅展示）', category: 'transform', weight: 1,
    needsSecret: false, clientOnlyInput: true, outputScopedToUser: true, hasFallback: true,
  },
  {
    id: 'trace.write', label: '调用链路留痕', category: 'audit', weight: 2,
    needsSecret: true, clientOnlyInput: false, outputScopedToUser: false, hasFallback: false,
  },
  {
    id: 'history.parse', label: '历史消息解析/格式化/排序', category: 'transform', weight: 3,
    needsSecret: false, clientOnlyInput: true, outputScopedToUser: true, hasFallback: true,
  },
  {
    id: 'content.markdown', label: 'Markdown 渲染与代码高亮', category: 'render', weight: 4,
    needsSecret: false, clientOnlyInput: true, outputScopedToUser: true, hasFallback: true,
  },
  {
    id: 'docgen.pdf', label: 'PDF / Office / Excel 生成', category: 'docgen', weight: 5,
    needsSecret: false, clientOnlyInput: true, outputScopedToUser: true, hasFallback: true,
  },
  {
    id: 'media.thumbnail', label: '图片压缩 / 缩略图', category: 'media', weight: 4,
    needsSecret: false, clientOnlyInput: true, outputScopedToUser: true, hasFallback: true,
  },
  {
    id: 'search.filter', label: '已取回结果的过滤/排序/分页', category: 'transform', weight: 3,
    needsSecret: false, clientOnlyInput: true, outputScopedToUser: true, hasFallback: true,
  },
  {
    id: 'stats.admin', label: '管理页统计聚合', category: 'aggregate', weight: 3,
    needsSecret: false, clientOnlyInput: false, outputScopedToUser: false, hasFallback: false,
  },
];

/** 汇总：可下沉 / 必须留服务端。 */
export function summarize(tasks: ComputeTask[] = PLATFORM_TASKS) {
  const out = tasks.map((t) => ({ id: t.id, label: t.label, weight: t.weight, ...classify(t) }));
  return {
    movable: out.filter((r) => r.verdict !== 'server'),
    mustStayServer: out.filter((r) => r.verdict === 'server'),
    /** 可按 weight 降序取下沉优先级：先搬重的 */
    movableByWeight: out.filter((r) => r.verdict !== 'server').sort((a, b) => b.weight - a.weight),
  };
}

/**
 * 降级路径检查：可下沉任务必须声明 hasFallback，
 * 否则 verdict 会被降级为 client-with-fallback（不可直接上线）。
 */
export function requiresFallback(task: ComputeTask): boolean {
  const d = classify(task);
  return d.verdict === 'client-with-fallback';
}
