# Requirements Document — Knowledge Self-Repair & Lifecycle Refresh

Feature Name: knowledge-self-repair-lifecycle
Updated: 2026-09-27
Status: Architecture Frozen (v1, 三项决策已由用户确认冻结)

## Introduction

把 CortexAI Knowledge Runtime 从"整理-研究各自为政"升级为可持续运行的
"记录 → 整理 → 验证 → 发现问题 → 自补缺 → 再验证 → 更新 → 定期刷新 → 按长期稳定性自适应刷新频率"
闭环知识系统。本次范围严格限定：

- 知识库自整理（现有 knowledgeOrg 链路，扩展不重写）
- 新资料准确性检查（Accuracy Gate）
- 自补缺 / Research 回流（Self-Repair Task → Research → 证据回流）
- 资料生命周期与刷新状态（recordedAt 体系 + FactRefreshState 独立状态机 + 周期刷新调度）

不在范围内：Prompt/Skill Runtime（见 scenario-adaptive-prompt-skill-evolution spec）、
模型路由、计费、权限。

职责边界（硬约束）：

```text
Knowledge Organization  发现结构问题 / 合并 / 拆分 / 分类 / 关系 / 重组
Accuracy Gate           判断新资料可信度, 只出判定, 不写事实
Self-Repair / Research  外部搜索 / 独立证据 / 交叉验证 / 冲突裁决
FactWriter (规则层)     唯一事实写口: 状态、版本、事务、生命周期
Refresh Scheduler       到期检测 / 拆独立 task / 并发调度 / 自适应周期
```

AI 负责判断与发现；规则系统负责状态、版本、事务、生命周期；
研究系统负责外部证据；整理系统负责知识结构。四个职责不互相越界。

## Glossary

- **recordedAt**: fact 第一次正式写入知识库的时间，永不因刷新改变。
- **sourceRetrievedAt**: 本次从外部来源取得资料的时间（Evidence.observedAt / EvidenceSource.retrievedAt，已有字段）。
- **lastVerifiedAt**: 最近一次准确性验证通过时间。
- **lastRefreshedAt**: 最近一次刷新任务真正完成时间。
- **nextRefreshAt / refreshIntervalMonths / refreshCycle**: 刷新计划，落在独立的 FactRefreshState 表。
- **FactRefreshState**: 独立于 KnowledgeFact 的刷新状态表（何时验、多频繁、失败退避），与 fact 一一对应。Fact 管"知识是什么"，RefreshState 管"什么时候重新验证它"。
- **Accuracy Gate 五态**: PASS / NEEDS_VERIFICATION / CONFLICT / SUSPECTED_INACCURATE / OUTDATED。
- **刷新结果七态**: UNCHANGED / MINOR_CHANGE / MATERIAL_CHANGE / CONFLICT / SOURCE_GONE / UNVERIFIED / ERROR（外加 REFRESH_FAILED 执行态）。
- **SelfRepairTask**: 用户库中的自补缺任务（与 KnowledgeBlindSpot 同库），带 rootTaskId/parentTaskId/iteration 血缘。

## 冻结决策（用户已确认，不得推翻）

### D1 — SelfRepairTask 放 User 库

- 与 KnowledgeBlindSpot 同库，researchJobId 关联语义完整。
- 跨库引用沿用现有惯例（blindSpotDetector 已在 user 库查询 fact/object id）。
- fact 侧刷新状态（FactRefreshState、FactLifecycleHistory、AccuracyGateDecision）全部在 knowledge 库。

### D2 — REFRESH_FAILED 退避状态机（连续失败计数，可配置）

```text
正常刷新
   ↓
REFRESH_FAILED #1
   ↓ 维持原 nextRefreshAt
REFRESH_FAILED #2
   ↓ 维持原 nextRefreshAt
REFRESH_FAILED #3
   ↓ 降为 LOW priority
   ↓ 暂停 PAUSE_CYCLES_AFTER_MAX_FAILURES 个周期 (pausedUntil)
   ↓ 再次尝试
   ↓ 成功后 consecutiveFailureCount = 0
```

- "3 次失败" = **连续**失败次数（consecutiveFailureCount），不是历史累计。
  失败→失败→成功→失败 ⇒ consecutiveFailureCount = 1，不是 4。
  任一次成功立即清零。
- 配置项（不得写死）：
  - `MAX_CONSECUTIVE_REFRESH_FAILURES`（默认 3）
  - `PAUSE_CYCLES_AFTER_MAX_FAILURES`（默认 1）
  - 达到上限：task priority 降为 LOW + FactRefreshState.pausedUntil = now + 一个刷新周期，到点重新尝试。
- 失败一律不累计 unchangedStreak、不降频、不得把 fact 判为 UNCHANGED。

### D3 — 第一版刷新范围（冻结边界）

只有满足以下全部条件的 fact 才创建/保留周期刷新计划：

```text
lifecycleStatus = 'ACTIVE'
AND
verificationStatus IN ('VERIFIED','SUPPORTED','CONFLICTED','UNVERIFIED')
```

| Fact 状态 | 周期刷新 |
|---|---|
| ACTIVE + VERIFIED | 是 |
| ACTIVE + SUPPORTED | 是 |
| ACTIVE + CONFLICTED | 是 |
| ACTIVE + UNVERIFIED | 是 |
| MERGED / DUPLICATE / ARCHIVED / INVALID | 否 |

CONFLICTED 与 UNVERIFIED 仍参与刷新（它们最需要后续验证）；
终态 lifecycle 的历史记录保留，但不进入 Active Refresh Scheduler。
Fact 进入非 ACTIVE lifecycle 时，对应 FactRefreshState 行置为 `archived` 并停止派发（不删除行）。

### D4 — FactRefreshState 独立表（用户追加确认）

刷新计划不与 Fact 本身混放。独立维护：

```text
factId / nextRefreshAt / refreshIntervalMonths / priority
consecutiveFailureCount / lastRefreshAt / lastRefreshStatus
pausedUntil / unchangedStreak / refreshCycle / archived
```

Data flow：

```text
Knowledge DB
┌────────┴────────┐
↓                 ↓
Fact        FactRefreshState
│                 │
│          nextRefreshAt / priority / retry
│
↓
Refresh / Research
↓
┌──────┴──────┐
↓             ↓
Verification  REFRESH_FAILED
↓             ↓
Fact 更新     Backoff / Pause
```

## Requirements

### R1 — 资料生命周期时间字段

1. WHEN 一条 KnowledgeFact 首次写入，系统 SHALL 以 `createdAt` 作为 recordedAt（不新增同义列，避免双源），并保证刷新/验证/整理永不改写该列。
2. Fact 的任何刷新/验证/整理操作 SHALL 不修改 recordedAt。
3. 每次外部来源取证 SHALL 记录 sourceRetrievedAt（Evidence.observedAt，已有）。
4. 每次准确性验证通过 SHALL 更新 lastVerifiedAt。
5. 每次刷新任务完成 SHALL 更新 FactRefreshState.lastRefreshAt。
6. Fact 与 FactRefreshState SHALL 保留完整历史：FactLifecycleHistory（事件流，write-once）+ 现有 OrganizationSnapshot/OrganizationRecord（整理历史）+ Evidence 行（证据历史），历史行不覆盖、不删除。

### R2 — Accuracy Gate（轻量判定层，不重写事实）

1. WHEN Organization Job 或 Research 回流产生新/变资料，系统 SHALL 先过 Accuracy Gate，再进整理或写库。
2. Gate 输入 SHALL 包含：新资料、来源信息（isOfficial/qualityScore/domain/observedAt）、同 object 已有相关知识与证据、本次来源时间、必要上下文。
3. Gate 输出 SHALL 限定五态：PASS / NEEDS_VERIFICATION / CONFLICT / SUSPECTED_INACCURATE / OUTDATED，判定写入 AccuracyGateDecision（含 confidence 与输入摘要 JSON）。
4. 判定为 PASS：继续正常整理流程，更新 lastVerifiedAt。
5. 判定为非 PASS：Gate SHALL 只产生 SelfRepairTask（复用或新建），SHALL 不直接修改 fact 值、SHALL 不直接选择冲突方。
6. 冲突场景（如 5000mAh 官方 vs 4500mAh 三方）SHALL 走 SelfRepair → 独立证据检索 → 交叉验证 → 规则层写最终状态，禁止 Gate 直接覆盖。
7. 证据独立性：同 domain 的多个来源 SHALL 只计 1 个独立证据；"多个低质网站重复" 不提升可信度。
8. "暂时没有证明它错" SHALL 倾向 NEEDS_VERIFICATION 而不是 PASS（如论坛孤证 + 官方无说明）。
9. 长期稳定且多次高可信验证的数据，SHALL 不因每个 Organization Job 都触发深度 Research；Gate 只对"新增/新证据/新来源/新出现的关键数字/价格/版本/日期/规格/兼容性/实时状态/低可信来源的重要结论/与已有知识冲突项"做加强验证。

### R3 — Self-Repair 回流（任务血缘 + 去重）

1. 非 PASS 判定 SHALL 创建或复用 SelfRepairTask，字段至少：taskId、parentTaskId、rootTaskId、triggerType、iteration、refreshCycle、targetEntity、targetFactId、reason、status（OPEN/RESEARCHING/EVIDENCE_READY/RESOLVED/CANNOT_VERIFY/TERMINATED）、researchJobId。
2. 同一 (rootTaskId + targetFactId + refreshCycle + 相同问题) SHALL 通过数据库唯一约束去重，不得无限创建重复 Repair Task；再次检查发现"无新证据/无新变化/问题已解决"时 SHALL 置 TERMINATED 终止当前闭环。
3. Research 完成后 SHALL 存在完整回流链：Research → Evidence → Cross Validation → Verification Result → 原 Fact 更新（必要时重新 Organization）→ 闭环完成；ResearchJob completed 本身不构成回流完成。
4. Research 失败/证据不足时 SHALL 不删除原 Fact；标记 INSUFFICIENT_EVIDENCE / CANNOT_VERIFY / CONFLICTED，保留原 fact、历史证据、验证记录、最近查询时间与下次检查时间（缩短周期）。
5. 血缘 SHALL 支持从任一任务反向追踪：谁创建、为什么、来自哪个任务、属于哪个 refreshCycle、针对哪条 Fact、尝试几次、用了哪个模型/Key、查了哪些来源、得到什么证据、最终如何改变知识。

### R4 — 周期刷新调度（Refresh Scheduler）

1. 所有满足 D3 条件的 fact SHALL 在 FactRefreshState 中存在刷新计划（首次默认 1 个月周期）。
2. WHEN nextRefreshAt <= now，Scheduler SHALL 将该 fact 拆成独立 RefreshTask 放入持久化任务队列；SHALL 不创建"包含 N 条资料的超级 Refresh Job"。
3. Scheduler 派发 SHALL 幂等：同 (factId, refreshCycle) 已有 QUEUED/RUNNING task 时不重复创建。
4. RefreshTask 执行 SHALL 有界并行：多个 fact 同时查询，禁止 Fact1 → 等待 → Fact2 串行。
5. 每次刷新 SHALL 记录独立 Refresh History 行：refreshTaskId、targetFactId、refreshCycle、startedAt、completedAt、sourceRetrievedAt、result、oldValue、newValue、changeType、evidenceIds、verificationStatus、previousRefreshInterval、newRefreshInterval。

### R5 — 结构化"无变化"判定

1. 刷新比较 SHALL 是语义/结构化比较，不是文本字符串比较：
   - "搭载 5000mAh" vs "配备 5000 mAh" → UNCHANGED（semantic fact unchanged）
   - "支持 Android 15" vs "支持 Android 16" → MATERIAL_CHANGE（单数字变化也是实质变化）
2. 结果 SHALL 区分：UNCHANGED / MINOR_CHANGE / MATERIAL_CHANGE / CONFLICT / SOURCE_GONE / UNVERIFIED / ERROR（执行态 REFRESH_FAILED 另计）。
3. UNCHANGED 与 MINOR_CHANGE SHALL 累计 unchangedStreak（MINOR_CHANGE 表示格式/表述层面的微调，事实未变）；MATERIAL_CHANGE SHALL 清零 streak 并升频。
4. 本轮搜索/抓取失败 SHALL 判 REFRESH_FAILED：不累计 unchangedStreak、不降频（按 D2 状态机退避）。
5. 来源消失（官方页 404）SHALL 判 SOURCE_GONE → 查找替代官方来源 → 必要时 SelfRepair；SHALL 不判 UNCHANGED。

### R6 — 自适应刷新频率（动态信任）

1. 刷新频率 SHALL 随证据演化：
   - 首次：1 个月；
   - 连续 3 轮 UNCHANGED → 2 个月；再 3 轮 → 3 个月；长期高度稳定 → 6 个月（阶梯可配置，不得硬编码不可调）。
2. 决策输入 SHALL 包含：连续无变化次数、历史验证次数、来源稳定性、来源权威度、冲突率、资料变化速度、最近一次变化距今时间、风险等级、最近失败率。
3. 升频机制（对称降频）：MATERIAL_CHANGE → 立即回到 1 个月；连续变化 → 更高频（如 2 周，可配置）。
4. 单次查询失败 / 来源消失 / 证据不足 SHALL 阻止降频，按 D2 退避。
5. 同一来源转载链（A 转 B、B 转 C）SHALL 按独立来源去重后计证据强度；"3 个来源一致"若实际只有 1 个独立来源，SHALL 不视为强证据。

### R7 — 并发与资源调度

1. 系统 SHALL 支持：大量月度刷新 + 大量 Self-Repair + 大量 Accuracy Recheck + 多个 Organization Job + 多个 Research Job（每个拆多个 Query）+ 多个网页抓取 + 多个 AI Worker 同时存在。
2. 并发控制 SHALL 分层：Global / Job-type / Provider / Model / API-key / Search / Fetch / DB write 各自独立限额；任务队列可堆 10 万条，实际同时执行受有界并发约束（禁止 `Promise.all(N 万)`）。
3. Task SHALL 具备：attemptCount、status、lease、startedAt、heartbeat、completedAt、lastError；Worker 崩溃 → lease 过期 → 任务回队列；成功但 Worker 崩溃 → 幂等防重复写（同 fact 刷新按 (factId, refreshCycle) 幂等键）。
4. API Key 池 SHALL 参与调度：Provider → Model → 可用 Key 池 → Lease → Request → Release；429/timeout 允许切其它可用 Key（复用现有 apiKeyPool，不重建）。
5. 优先级 SHALL 支持 CRITICAL / HIGH / NORMAL / LOW + Fair Scheduling + Aging + Per-Type Quota；10 万 LOW 任务 SHALL 不饿死 CRITICAL（SHALL 不长期堵死自补缺）。
6. Organization 内部：Issue Detection → Task Decomposition → 大量 Organization Tasks 并行 AI Worker → Result Pool → Merge → Deterministic Pre-check → Final Validation → Single Writer；分析并行、写库受控。
7. Research 内部：Research Job → Query Planner → 多个 Query Task 并行（有依赖的才等待，无依赖全部并行）→ 每个 Query 的多个 Source Fetch 并行 → Evidence Collector；"模型 A 查 Q1、模型 B 查 Q2"合法。
8. 并发度 SHALL 是 Adaptive Concurrency Controller：资源空闲（Key 多、网络空闲、DB 空闲）可提升；Provider 限流/Key 紧张/DB 压力大时自动降低。

### R8 — 数据一致性（最高优先并发规则）

1. 禁止多个 AI 同时直接修改同一 Fact；必须：Parallel Compute → Result Collection → Conflict Resolution → Deterministic Plan → Single Writer / Transaction → Apply。
2. 多个 Worker 对同一 fact 给出不同值（5000 / 4500 / 5000）SHALL 建立冲突集合 → 来源权重 → 统一验证 → 再写最终状态；SHALL 不采用"最后完成者覆盖"。
3. Accuracy Gate 的判定、Research 的证据、最终 fact 状态转换 SHALL 都是确定性状态机：AI 提出"需要验证/归因系数"，规则系统决定建什么 Task、写什么状态；SHALL 不让 AI 随机改数据库状态。

### R9 — 最小改造纪律

1. 现有 orgSnapshot / deterministicScan / splitTasks / runWorkers / mergeResults / preCheck / validator / applyPlan（Single Writer）SHALL 扩展而非重写。
2. 本次改动产生的孤儿 import/变量/函数 SHALL 清理；与任务无关的既有死代码 SHALL 不动。
3. 每一个主要修改 SHALL 有可验证成功标准（目标 → 最小必要修改 → 验证方式），SHALL 不以"代码看起来合理"为完成标准。

## Verification Plan（实现阶段逐项验收）

1. **时间戳不变性**：构造 fact，跑 3 轮 UNCHANGED + 1 轮 MATERIAL_CHANGE → 断言 recordedAt 恒定、lastRefreshedAt 递增、lastVerifiedAt 仅在验证通过时更新、FactLifecycleHistory 事件完整。
2. **刷新闭环**：nextRefreshAt < now → Scheduler 运行 → 产生独立 RefreshTask（N fact = N task）→ Worker 消费 → 断言 lastRefreshAt 更新、nextRefreshAt 推到下周期、task 幂等不重复。
3. **降频/升频**：mock 3 轮 UNCHANGED（含"文本不同数值相同"用例）→ interval 1→2 月；MATERIAL_CHANGE → 回 1 月；再连续变化 → 2 周。
4. **失败不误判**：来源 404 → SOURCE_GONE；全部 query 超时 → REFRESH_FAILED；两者均不累计 unchangedStreak、不降频、不删 fact；失败 ×3 → LOW + 暂停 1 周期（pausedUntil）→ 恢复 → consecutiveFailureCount 清零。
5. **Gate 五态**：官方改值 → OUTDATED 直通写新值（保留旧值历史）；论坛孤证 → NEEDS_VERIFICATION → 建 repair task；数值互斥 → CONFLICT → 不选边；低质重复源按 domain 去重判证据不足。
6. **回流**：repair 关联 research job 完成 → fact version+1 + history + 受影响 scope 触发 organization job + task=RESOLVED；证据不足 → fact 原值保留、INSUFFICIENT_EVIDENCE、周期缩短。
7. **去重闭环**：同 fact 同周期同问题连触发 3 次 → SelfRepairTask 唯一行，iteration 递增。
8. **并发压力**：10 / 50 / 100 RefreshTask + 3 ResearchJob（各 5 query）+ 1 Org Job → 断言 provider 槽位不超限、无 task 丢失、无重复写入、无 DB 竞争错误、崩溃 lease 恢复、CRITICAL 不被 LOW 堵死、堆 1000 task 时内存无 1000 个 in-flight promise。
9. **单 Job 内并行实证**：5 query 同时运行（日志时间戳证据），N 个 query 不因源码无必要 await 串行；每 query 的 4 个来源并行抓取。
10. **回归**：`npm run build` 全绿；`POST /knowledge/organization/trigger` 与 `/research/trigger` 在灰度开关关闭时与旧行为一致。

## References

- 用户需求三段：知识闭环原则（12 条）/ 持续刷新高并发（22 条）/ 执行与工程纪律（26 条）
- 冻结决策 D1-D4（SelfRepairTask@User 库、连续失败退避状态机、刷新范围边界、FactRefreshState 独立表）
- 源码勘察：knowledgeOrg/{orgRuntime,orgWorkers,orgPrompts,orgApplier,orgScanner,orgSnapshot,orgResultPool,orgValidator}.ts、researchExecutor.ts、researchManager.ts、knowledgeRuntime.ts、blindSpotDetector.ts、crossValidation.ts、coverageAnalysis.ts、evidenceCollector.ts、searchLayer.ts、readerLayer.ts、workerPool.ts、apiKeyPool.ts、prisma/schema-{user,knowledge}.prisma
