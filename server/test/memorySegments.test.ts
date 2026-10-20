// 上下文压缩 — Token 预算与分段边界测试（纯逻辑，无 DB、无模型）。
//
// 对应任务书 18.2 / 18.3 中不依赖真实数据库与模型调用的部分：
//   - 85% 触发阈值基于"可用输入预算"而非标称容量
//   - 不同模型上下文窗口/输出预留分别处理
//   - 分段按 Token 预算与话题边界，不按条数
//   - 段请求实际输入均低于可用输入限制并预留输出
//   - 单个超长消息不丢弃
//   - 工具调用组不被拆开
//   - 多级合并分组与层数估计
// ================================================================

import {
  estimateTokens, computeInputBudget, computeCompressionCallBudget,
  resolveModelCapacity, resolveBudgetConfig, estimateContextTokens,
} from '../src/services/memoryManager/tokens';
import {
  planSegments, assignLayers, planMergeGroups, mergeDepthEstimate,
  type SegmentableMessage,
} from '../src/services/memoryManager/segments';

let pass = 0, fail = 0;
const check = (n: string, c: boolean, e = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, e));
const S = (n: string) => console.log('\n' + n);

const FLASH_32K = { contextWindow: 32768, maxOutputTokens: 8192 };
const CLAUDE_200K = { contextWindow: 200000, maxOutputTokens: 8192 };
const SMALL_8K = { contextWindow: 8192, maxOutputTokens: 2048 };

(async () => {
  // ============================================================
  S('1. 85% 触发阈值基于可用输入预算，不基于标称容量');
  {
    const cfg = resolveBudgetConfig();
    const b = computeInputBudget(FLASH_32K, { historyMessages: 'x'.repeat(10000) }, cfg)!;
    check('预算对象生成（模型有真实 contextWindow）', !!b);
    // usableInput = 32768 - reserve - safety
    const expectedUsable = 32768 - b.reservedOutput - b.safetyMargin;
    check('usableInput = 窗口 - 输出预留 - 安全余量', b.usableInput === expectedUsable);
    check('triggerThreshold = usableInput × 0.85', Math.abs(b.triggerThreshold - expectedUsable * 0.85) <= 1,
      `${b.triggerThreshold} vs ${expectedUsable * 0.85}`);
    check('triggerThreshold 明显小于标称容量', b.triggerThreshold < FLASH_32K.contextWindow * 0.85);
  }

  S('2. 输出预留不超过可用容量比例 —— 小模型不被输出预留吃光');
  {
    const tiny = { contextWindow: 4096, maxOutputTokens: 4000 };  // 输出上限接近窗口
    const b = computeInputBudget(tiny, {}, resolveBudgetConfig())!;
    check('输出预留被 cap 限制（4000 → 1024）', b.reservedOutput === 1024, `got ${b.reservedOutput}`);
    check('仍然有可用的输入预算', b.usableInput > 2000, `usable=${b.usableInput}`);
  }

  S('3. 未知/为 0 的 contextWindow 必须返回 null，不得用默认值猜测');
  {
    check('contextWindow=0 → null', computeInputBudget({ contextWindow: 0, maxOutputTokens: 100 }, {}) === null);
    check('contextWindow=null → null', computeInputBudget(null, {}) === null);
    check('resolveModelCapacity(0) → null', resolveModelCapacity({ contextWindow: 0, maxTokens: 0 }) === null);
    check('resolveModelCapacity(32768/8192) → 正常', resolveModelCapacity({ contextWindow: 32768, maxTokens: 8192 })?.contextWindow === 32768);
  }

  S('4. 触发判定：达到 85% 才触发，低于不触发');
  {
    const cfg = resolveBudgetConfig();
    const budget = computeInputBudget(FLASH_32K, {}, cfg)!;
    // 构造刚好达到阈值的输入
    const triggerText = 'y'.repeat(budget.triggerThreshold * 2);   // 估算 ~阈值 token
    const at = computeInputBudget(FLASH_32K, { historyMessages: triggerText }, cfg)!;
    check('达到阈值 → shouldTrigger=true', at.shouldTrigger === true);
    const below = computeInputBudget(FLASH_32K, { historyMessages: 'y'.repeat(100) }, cfg)!;
    check('远低于阈值 → shouldTrigger=false', below.shouldTrigger === false);
  }

  S('5. 预算必须覆盖全部输入来源，不只是普通文本');
  {
    const withTools = estimateContextTokens({
      systemPrompt: 'sys',
      developerInstructions: 'dev',
      fixedPrompts: 'fixed block that every request attaches',
      dynamicPrompts: 'dynamic',
      summary: 'existing summary',
      historyMessages: 'history',
      currentRequest: 'user msg',
      toolDefinitions: JSON.stringify([{ name: 'a', inputSchema: { type: 'object' } }]),
      toolResults: 'tool output',
      agentState: 'plan/progress',
      multimodal: 'image budget',
    });
    const allPartsPositive = Object.values(withTools.breakdown).every((v) => v > 0);
    check('11 类输入全部计入预算', allPartsPositive, JSON.stringify(withTools.breakdown));
    check('总计为各类之和', withTools.total === Object.values(withTools.breakdown).reduce((a, b) => a + b, 0));
    // 验证非文本开销确实被计入：仅工具定义就应产生 token
    const onlyTools = estimateContextTokens({ toolDefinitions: '["a","b","c"]' });
    check('工具定义占用预算', onlyTools.total > 0);
  }

  S('6. 不同模型得到不同分段规模（不得对所有模型固定）');
  {
    const cb32 = computeCompressionCallBudget(FLASH_32K, 600, 100)!;
    const cb200 = computeCompressionCallBudget(CLAUDE_200K, 600, 100)!;
    const cb8 = computeCompressionCallBudget(SMALL_8K, 600, 100)!;
    check('200K 模型分段预算远大于 32K', cb200.segmentInputBudget > cb32.segmentInputBudget * 4);
    check('8K 模型分段预算最小', cb8.segmentInputBudget < cb32.segmentInputBudget);
    check('分段预算 < 该模型可用输入上限', cb200.segmentInputBudget < cb200.hardLimit);
    check('分段预算已预留压缩提示词与输出', cb200.segmentInputBudget <= cb200.hardLimit - 600 - cb200.outputReserve);
  }

  S('7. 分段：装得下就不分段');
  {
    const msgs: SegmentableMessage[] = Array.from({ length: 10 }, (_, i) => ({
      seq: i + 1, role: i % 2 ? 'assistant' : 'user', content: `msg ${i}`,
    }));
    const plan = planSegments(msgs, 100000);
    check('不需要分段', plan.needsSegmentation === false);
    check('只有一个段且覆盖全部', plan.segments.length === 1 && plan.segments[0].messages.length === 10);
    check('范围连续（startSeq..endSeq）', plan.segments[0].startSeq === 1 && plan.segments[0].endSeq === 10);
  }

  S('8. 分段：超容量时自动分段，且每段都不超预算');
  {
    // 每条 200 字符 ≈ 100+ token；预算给 400 → 每段约 3~4 条
    const msgs: SegmentableMessage[] = Array.from({ length: 40 }, (_, i) => ({
      seq: i + 1, role: 'user', content: 'z'.repeat(200),
    }));
    const budget = 400;
    const plan = planSegments(msgs, budget);
    check('需要分段', plan.needsSegmentation === true);
    check('产生多段', plan.segments.length > 1, `got ${plan.segments.length}`);
    const allWithin = plan.segments.every((s) => s.estimatedTokens <= budget + 1);
    check('每段估算 token 均 ≤ 分段预算', allWithin, plan.segments.map((s) => s.estimatedTokens).join(','));
    const rangesInOrder = plan.segments.every((s, i) => i === 0 || s.startSeq > plan.segments[i - 1].startSeq);
    check('分段按原始顺序排列', rangesInOrder);
  }

  S('9. 分段边界尊重完整对话轮次与工具调用组');
  {
    const msgs: SegmentableMessage[] = [];
    let seq = 1;
    // 3 个"轮次"：user + assistant(tool_group) + assistant(final)
    for (let r = 0; r < 3; r++) {
      msgs.push({ seq: seq++, role: 'user', content: 'q' + r });
      msgs.push({ seq: seq++, role: 'assistant', content: 'calling', toolGroupId: `g${r}`, isToolCall: true });
      msgs.push({ seq: seq++, role: 'tool', content: 'result', toolGroupId: `g${r}`, isToolResult: true });
      msgs.push({ seq: seq++, role: 'assistant', content: 'answer' + r });
    }
    // 预算只够装下一组多一点 → 工具组必须整组不被拆开
    const plan = planSegments(msgs, 60);
    check('工具组所在段同时含 call 与 result', (() => {
      for (const s of plan.segments) {
        const hasCall = s.messages.some((m) => m.isToolCall);
        const hasResult = s.messages.some((m) => m.isToolResult);
        if (hasCall !== hasResult) return false;   // 不完整
      }
      return true;
    })());
    check('工具组整体不跨段（组内消息同段或整组同段）', (() => {
      // 正确的不变量：同一 toolGroupId 的所有消息必须落在**同一个段索引**。
      // 旧断言用全局 seen 集合判重，把"组出现在两个相邻段"当失败，
      // 但那不是本实现的问题 —— 只要组内消息段索引一致即可。
      const byGroup = new Map<string, Set<number>>();
      for (const s of plan.segments) {
        for (const m of s.messages) if (m.toolGroupId) {
          const set = byGroup.get(m.toolGroupId) || new Set<number>();
          set.add(s.index);
          byGroup.set(m.toolGroupId, set);
        }
      }
      for (const [, segs] of byGroup) if (segs.size !== 1) return false;
      return true;
    })());
  }

  S('10. 分段保留段间重叠背景（供合并时去重），不重复计入');
  {
    const msgs: SegmentableMessage[] = Array.from({ length: 30 }, (_, i) => ({
      seq: i + 1, role: 'user', content: 'm'.repeat(300),
    }));
    const plan = planSegments(msgs, 500, { overlapMessages: 1 });
    // 重叠是允许的，但必须在合并时能识别（用 startSeq 重叠检测）
    let overlaps = 0;
    for (let i = 1; i < plan.segments.length; i++) {
      if (plan.segments[i].startSeq <= plan.segments[i - 1].endSeq) overlaps++;
    }
    check('相邻段存在重叠背景（合并阶段需去重）', overlaps > 0, `overlaps=${overlaps}`);
  }

  S('11. 单条超长消息：不丢弃，标记为需引用式保留');
  {
    const msgs: SegmentableMessage[] = [
      { seq: 1, role: 'user', content: 'normal' },
      { seq: 2, role: 'assistant', content: 'H'.repeat(100000) },   // 单条 ≈ 5 万 token
      { seq: 3, role: 'user', content: 'after' },
    ];
    const plan = planSegments(msgs, 500);
    check('超长消息被标记 oversized', plan.oversizedMessages.some((m) => m.seq === 2));
    check('超长消息内容仍完整保留在 oversized 中（未被截断丢弃）',
      plan.oversizedMessages.find((m) => m.seq === 2)?.content.length === 100000);
    check('其余消息仍被正常分段', plan.segments.some((s) => s.messages.some((m) => m.seq === 3)));
  }

  S('12. 分层策略：近段高细节、中段脉络、远段重点');
  {
    const layers = assignLayers(100);
    check('最后一条是 recent', layers[99] === 'recent');
    check('倒数 25% 内为 recent', layers[80] === 'recent');
    check('中段为 mid', layers[50] === 'mid');
    check('最早一条为 distant', layers[0] === 'distant');
    check('三种层都存在', new Set(layers).size === 3);
    // 短对话不会被硬切成三层
    const tiny = assignLayers(2);
    check('2 条对话不产生 distant', !tiny.includes('distant'), JSON.stringify(tiny));
  }

  S('13. 多级合并：分组计划与层数估计');
  {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, tokens: 1000 }));
    const groups = planMergeGroups(items, 4500);
    check('按预算分组（每组 ≤ 预算）', groups.every((g) => g.reduce((a, x) => a + x.tokens, 0) <= 4500));
    check('所有分组覆盖全部项', groups.flat().length === 20);
    check('分组按原始顺序', JSON.stringify(groups.flat().map((x) => x.id)) === JSON.stringify(items.map((x) => x.id)));
    check('装得下时层数为 0', mergeDepthEstimate(4000, 4500) === 0);
    const d = mergeDepthEstimate(1_000_000, 4500);
    check('超大历史需要多级合并且层数有限（防无限合并）', d >= 1 && d <= 12, `depth=${d}`);
  }

  S('14. 防误用：估算函数对空值与极短输入稳健');
  {
    check('空串 → 0', estimateTokens('') === 0);
    check('undefined 安全', estimateTokens(undefined as any) === 0);
    check('1 字符至少 1 token', estimateTokens('a') >= 1);
    check('递增单调', estimateTokens('abcdefgh') >= estimateTokens('abcd'));
  }

  console.log(`\n记忆分段测试：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail > 0 ? 1 : 0;
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
