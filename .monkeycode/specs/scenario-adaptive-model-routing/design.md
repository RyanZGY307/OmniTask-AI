# Scenario-Driven Adaptive Model Routing — Design

Feature Name: scenario-adaptive-model-routing
Updated: 2026-09-27
Status: Implementation-Ready (Architecture Frozen)

## Description

实时路径：`Scenario + 候选模型池 + Model × Scenario Compatibility + 全局健康/延迟/成本` → 纯规则 <1s 选出 Primary + Fallback。
后台路径：M1-M6 六个 AI Worker 经 Persistent Queue + Bounded Concurrency 建立/修正 Model × Scenario 经验，规则统计引擎落库。

## Architecture

### 数据流（全图）

```text
Model Registry (config.ts 种子 + ModelConfig DB 合并, getDynamicModels)
  → Entitlement (user.subscriptionTier) → Runtime Model Pool (动态, 含 Pool Version)
    → Global Scenario Registry (knowledge 库, 唯一场景源)
      → AI 初始画像 (M1/M2/M3, 后台并行, 有界)
        → Model × Scenario Compatibility (knowledge 库, 唯一经验存储)
          → 真实用户实验 (一次请求一个模型, 跨用户跨时间)
            → M5 Outcome (发生了什么) → M6 Attribution (归因给谁)
              → 规则证据更新 (跨用户统计 + 时间衰减 + 置信区间)
                → Compatibility 更新 → Fast Router (零 AI 实时读取)
```

### 实时路由伪码（零 AI）

```text
function route(user, scenarioId, context) {
  pool = getAvailableModels(user)                // Entitlement + Registry, 运行时
  pool = hardFilter(pool, context)               // 12 维, AI 不可突破
  rows = readModelScenarioCompat(scenarioId)      // point lookup + 继承 prior
  scored = pool.map(m => {
    const row = rows[m.id]
    const es  = row?.evidenceStrength ?? 0
    const staticWeight = 1 - es                    // R5 线性交接, 无跳变
    return staticPrior(m, context) * staticWeight  // 静态 Task/能力先验
         + compat(m, row) * es                     // 真实 Model×Scenario 证据
         + health(m) + latency(m) + cost(m) + verification(m)
  })
  { primary, fallbacks } = exploitExplore(scored) // reject 模型不进 explore
  if (!primary) primary = mostExecutableFallback(pool)  // 永非空
  return { primary, fallbacks }                   // fallback 切换纯规则
}
```

### 后台画像链路（队列 + 有界并发）

```text
ModelProfileJob (User 库):
  kinds: model_profile(M1) | model_scenario(M2/M3 扇出) | drift_reeval(M4) | outcome(M5) | attribution(M6)
  任务粒度: 一行 = 一个 (model_id, scenario_id) 或一个 (conversation, model, scenario) 反馈
  执行: workerPool tick 领取 → 有界并发 → apiKeyPool(429 冷却切 key) → 完成钩子
   完成钩子:
     M1/M2/M3 → 写 prior 字段 (semantic_fit/capability_fit/quality_expectation/reason_codes/risk/confidence/experiment_priority)
                + 初始化/补全 Matrix 行 (status=experimental, inherited 按父场景)
     M5       → Outcome 八态写 ExperimentRun (success/partial_success/correction/requirement_change/
                  model_issue_signal/scenario_issue_signal/output_issue_signal/uncertain)
     M6       → 系数写 AttributionRecord; RuleEvidenceUpdate 决定是否改 Matrix 统计列
  漂移监控: 每 7 天规则 job 扫描 Matrix (recent_performance < 0.4 且 experiments >= 20) → 入队 M4
```

### Pool Version 与增量重算

```text
poolVersionHash = sha1(
  排序后模型列表 map(m => `${m.key}@${m.version}:${m.status}:${m.capabilities.join(',')}`)
  + '|' + providerHealth 摘要(各 provider 健康分桶)
  + '|' + keyPoolAvailable(各 provider 有可用 key)
)
重大变化判定: hash 变化 且 变化集合非空 (新增/删除/版本/能力/Provider 状态/key 池可用性)
增量重算: affected = 变化模型 × 全场景 ∪ 新增场景 × 变化模型; 未受影响组合保留
M1 画像结果记录 poolVersion, 可追溯"这批先验针对哪个池"
```

## Components and Interfaces

### Prisma 新增（knowledge 库）

```prisma
model ModelScenarioCompatibility {
  id                 String   @id @default(cuid())
  modelId            String
  scenarioId         String
  compatibility      Float    @default(0.5)
  confidence         Float    @default(0.1)
  evidenceStrength   Float    @default(0)   // 派生值: min(1,uniqueUser/8)*0.5 + min(1,log2(exp+1)/6)*0.3 + (1-corrRate)*0.2
  experimentCount    Int      @default(0)
  uniqueUserCount    Int      @default(0)
  userDistribution   String   @default("[]")
  successCount       Int      @default(0)
  correctionCount    Int      @default(0)
  verificationCount  Int      @default(0)
  fallbackCount      Int      @default(0)
  recentPerformance  Float    @default(0.5)
  inherited          Boolean  @default(false)
  inheritedFromScenarioId String?
  lastExperimentAt   DateTime?
  poolVersion        String?
  semanticFit        String?  // high | medium | low | reject (M1/M2 写入)
  status             String   @default("experimental") // experimental | stable | reevaluating | deprecated
  lastEvaluated      DateTime?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
  @@unique([modelId, scenarioId])
  @@index([scenarioId, compatibility])
  @@index([status, evidenceStrength])
  @@index([modelId])
}

model ModelScenarioDiversity {   // scenario_diversity 按模型聚合: 该模型在多少不同场景达到 stable
  modelKey  String   @id
  stableCount Int    @default(0)
  updatedAt  DateTime @updatedAt
}

model ModelPoolVersion {
  id          String   @id @default(cuid())
  versionHash String   @unique
  modelsJson  String
  triggerType String   // first_init | new_model | new_scenario | pool_change | drift | user_feedback
  createdAt   DateTime @default(now())
}
```

### Prisma 新增（user 库，与 SkillAnalysisJob 同模式）

```prisma
model ModelProfileJob {
  id          String   @id @default(cuid())
  jobKind     String   // model_profile(M1) | model_scenario(M2/M3) | drift_reeval(M4) | outcome(M5) | attribution(M6)
  modelId     String?
  scenarioId  String?
  trigger     String   // first_init | new_model | new_scenario | pool_change | drift | user_feedback
  poolVersion String?
  status      String   @default("QUEUED")
  workerId    String?
  leaseUntil  DateTime?
  heartbeatAt DateTime?
  resultJson  String?
  attemptCount Int    @default(0)
  lastError   String?
  queuedAt    DateTime @default(now())
  completedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([status, queuedAt])
  @@index([jobKind, status])
  @@index([modelId, scenarioId])
  @@index([workerId, heartbeatAt])
  @@index([leaseUntil])
}
```

## 模型分配与 AI 调用点对照（冻结）

```text
W0 Intent              gemini-3.5-flash      (现有 contextAnalyzer.callGeminiAnalysis, 不动; 快路径时跳过)
M1/M2/M3/M4/M6        Agnes-3.0-flash       (新增 modelEvolution/ 下, 走 scenarioWorkers/agnesCaller 公共 caller)
M5                    Agnes-2.5-flash       (新增, 异步)
现有 Evolution         Agnes-3.0-flash      (evolution.ts, 不动; 共用 agnesCaller 不改变其行为)
实时 Router            零 LLM               (纯规则, 禁止任何现场模型判断)
```

## Components and Interfaces

### M 系列 Worker 输出 Schema（冻结，写库前 JSON Schema + 枚举白名单校验）

```json
M1/M2: { "semantic_fit": "high|medium|low|reject", "capability_fit": 0.0, "quality_expectation": 0.0,
         "reason_codes": ["..."], "risk": "low|medium|high", "confidence": 0.0, "experiment_priority": 0.0 }
M4:    { "drift": true, "lower_compatibility": true, "re_experiment": true, "rebuild_prior": false,
         "reason": "..." }
M5:    { "outcome": "success|partial_success|correction|requirement_change|model_issue_signal
                    |scenario_issue_signal|output_issue_signal|uncertain",
         "model_issue_signal": 0.0, "scenario_issue_signal": 0.0, "output_issue_signal": 0.0, "confidence": 0.0 }
M6:    { "target": "model|model_scenario|scenario|prompt|skill|knowledge|requirement_change",
         "direction": "positive|negative|neutral", "strength": 0.0, "confidence": 0.0, "reason": "..." }
```

统一 system prompt 约束：只输出指定 JSON；不输出 markdown；不执行工具；不写库；不产出最终路由决策；候选中不得出现无权限模型；Model Capability 与 Entitlement 判定分离。

### 实时硬过滤 12 维（规则层，AI 不可突破）

| 维度 | 数据源（现有） | 数据源（新） |
|---|---|---|
| 会员权限 (entitlement) | `User.subscriptionTier` vs ModelConfig.tier | `modelPool.getAvailableModels(user)` |
| 模型存在 | `getDynamicModels()[key]` | 同左 |
| active 状态 | ModelConfig.status/enabled | 同左 |
| Context Limit | `entry.contextWindow >= estimatedTokens` | 同左 + 场景级需求（M1 context_requirements） |
| Modality | `entry.category`（image/video 排除） | 同左 |
| Capability | `filterByCapability`（≥50% 匹配） | 同左 + 场景级 requiredCapabilities |
| Provider Health | `modelPerformanceStore.getHealthScore(provider)` | 同左 + ProviderHealth 表（如启用） |
| Rate Limit | `modelQuotaRegistry.canExecute(modelKey)` | 同左 |
| API Key 可用性 | `apiKeyPool.getApiKey(provider)` | 同左 + key pool 摘要进 Pool Version hash |
| 区域/部署限制 | （当前无，预留） | `entry.region` / 部署标记（配置项） |
| Pool Version 一致性 | （新） | `row.poolVersion` 与当前 `poolVersionHash` 一致，否则标记 stale |
| 其它系统硬限制 | （预留） | 系统级禁用列表（配置项） |

现有 7 层过滤（router.ts L322-346）全部保留并映射上表；新增 Rate Limit / API Key / 区域 / Pool Version / 其它 5 维由 `modelPool.ts` 的 Hard Filter 补齐。

### 灰度 flag

`CORTX_SCENARIO_MODEL_ROUTING` 为环境变量（`process.env`），默认 **off**；关闭时现有 `router.routeModel` 全链路行为不变。不引入 DB 配置表。

### 新增/改造文件（对照 Skill Spec 的实现模式）

| 文件 | 职责 |
|---|---|
| `services/modelEvolution/modelPool.ts` | `getAvailableModels(user)`：Registry + entitlement + key pool 可用性 → 运行时池；`detectPoolVersionChange` 增量决策 |
| `services/modelEvolution/m1Profiler.ts` | M1 单任务执行 + 输出校验 + prior 写 Matrix |
| `services/modelEvolution/m2NewScenario.ts` | 新 Scenario × 运行时池 扇出 N 任务（禁 Promise.all(全矩阵)） |
| `services/modelEvolution/m3NewModel.ts` | 新 Model × Global Registry 扇出 N 任务 |
| `services/modelEvolution/m4DriftReeval.ts` | 漂移信号 → M4 判定 + 规则层降 status |
| `services/modelEvolution/m5Outcome.ts` | 用户后续信号 → 八态（异步，不阻塞原回答） |
| `services/modelEvolution/m6Attribution.ts` | M5 → 归因系数（不写最终值） |
| `services/modelEvolution/ruleEvidenceUpdate.ts` | 时间衰减 + 跨用户证据 + 置信区间 → 更新 Matrix 统计列/compatibility/status |
| `services/modelRouter/scenarioRouter.ts` | 实时零 AI 路由（`route(user, scenarioId, context)`） |
| `services/workerPool.ts` | 新增 `modelProfile` job kind（lease/heartbeat/recoverStale 复用） |
| `services/router.ts` | 移除 `getDefaultModel` 硬编码 tier→模型列表；TASK_WEIGHTS 降为先验权重表（被 scenarioRouter 消费） |
| Prisma | knowledge 库 +`ModelScenarioCompatibility`/`ModelPoolVersion`；user 库 +`ModelProfileJob` |

## Correctness Properties

1. 实时路径（已有 Scenario）零 LLM 调用；Compatibility 为单行 point lookup；规则层 >200ms 防御时直接取候选池首个健康模型。
2. 矩阵更新必带 `scenario_id` 条件；无全局模型降分路径；模型表无全局质量分列（Skill Spec invariant 3 同构）。
3. 先验交接（线性，无跳变）：`staticWeight = 1 - evidence_strength`。es=0→纯先验；es=0.3→静态 0.7；es=0.6→静态 0.4；es=0.7→证据 0.7；es=1→纯证据。四档测试断言 es=0/0.3/0.6/0.9 → staticWeight=1.0/0.7/0.4/0.1。
4. 单用户封顶：1 用户 1000 次 < stable 门槛；40 用户 100 次可过。
5. `partial_success`/`requirement_change` 不计模型负面；仅 M6 `target=model*` 且 `direction=negative` 计入 correction。
6. 路由结果永非空（R9）；`no_match_fallback` 与 `primary_unavailable` 区分记录。
7. M1 prior 只在 pool_version 变化或 M4 `rebuild_prior=true` 时更新；普通实验只动统计列。
8. tier 变化只改候选池成员；权限不足的用户不产生实验行（矩阵历史不被权限波动污染）。
9. AI 输出写库前过 Schema + 枚举白名单；非法 → 任务 FAILED 可重试，矩阵不脏写。
10. Selection（M1/M2 prior 字段）与 Evaluation（success/correction 计数）不同字段来源，闭环无自我强化。

## Error Handling

| 场景 | 行为 |
|---|---|
| M1-M4 429/超时 | key pool 冷却切 key，3 次 → FAILED + attemptCount+1，下轮 tick 重试 |
| M2 扇出时池为空 | SKIPPED + 记录空池 pool_version；请求走 Cold Start |
| 新 Scenario 首请求（M2 未完成） | Cold Start Rule 立即选可执行模型，M2 后台跑 |
| M5 uncertain | 不产生归因；矩阵只累加 experiment_count |
| M6 target=Prompt/Skill | Model×Scenario 行不动；归因写 AttributionRecord 供 Evolution 消费 |
| 漂移（7 天 recentPerformance < 0.4 且 exp >= 20） | 规则触发 M4 → status=experimental + 重新实验；AI 不直接改 compatibility |
| Provider 全挂（健康 < 0.3） | 硬过滤移除该 provider；Fallback 跳下一健康 provider |
| Pool 重大变化 | 只重算受影响组合（变化模型 × 全场景 ∪ 新增场景 × 变化模型） |
| 规则层 >200ms 防御 | 取候选池首个健康模型 |

## Test Strategy

实现顺序（每步最小实现 + 断言）：

1. Prisma：knowledge +`ModelScenarioCompatibility`/`ModelPoolVersion`；user +`ModelProfileJob`；db push
2. `modelPool.ts`（池 + version hash + 增量检测）
3. `scenarioRouter.ts` 实时路由（零 AI 断言 + 非空断言 + 先验交接 4 档）
4. `ruleEvidenceUpdate.ts`（单用户封顶断言 + 矩阵隔离断言）
5. M1/M2/M3 扇出（500 场景任务粒度 + 并发上限 + 旧模型零重算断言）
6. M4 漂移（status 降级 + AI 不写值断言）
7. M5/M6 + 反馈不误伤断言（"再详细点" partial_success 不改矩阵）
8. workerPool `modelProfile` kind 接入（lease/heartbeat/recoverStale 回归）
9. `router.ts` 去硬编码（getDefaultModel 列表移除 + 回归）
10. 灰度 flag `CORTX_SCENARIO_MODEL_ROUTING`（默认 off，旧行为不变）+ `npm run build` 全绿

## References

- 用户需求（19 条原则 + M1-M6 + 模型池版本 + 冷启动 + Selection/Evaluation 分离）
- 现有源码：`server/src/services/{router,configSync,modelPerformanceStore,modelQuotaRegistry,modelCapabilityRegistry,scenarioRegistry,workerPool,evolution}.ts`、`server/src/config.ts`
- 关联：当前工作区 内的 `.monkeycode/specs/scenario-adaptive-prompt-skill-evolution/`（共享 Global Scenario Registry、workerPool lease 模式、兼容矩阵隔离 invariant）
