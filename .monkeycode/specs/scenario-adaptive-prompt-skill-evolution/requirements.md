# Requirements Document — Scenario-Driven Adaptive Instruction & Skill Evolution

Feature Name: scenario-adaptive-prompt-skill-evolution
Updated: 2026-09-27
Status: Architecture Frozen (v3) + Implementation Landed (4 项 ⚠️→✅)

Skill 根本原则（适用于 S1-S4 全部需求）：

Skill 是管理员提供的能力资产。AI 可以：理解 Skill、分类 Skill、分析 Skill 能力、
建立 Scenario 适配关系、判断 Skill 是否适合当前 Scenario、分析实验表现。
AI 不可以：生成新的正式 Skill、自行上传 Skill、自行发布 Skill、修改管理员原始 Skill、
因为某个 Scenario 失败而降低 Skill 全局质量。

## Introduction

升级 CortexAI 现有的"规则式 Task/Skill 选择 + AI 多维意图分析 + Atom/Scenario 拼装"系统为
Scenario-Driven Adaptive Instruction & Skill Evolution 架构。

职责边界（10 个 AI Worker + 规则层 + Evolution 层）：

```text
Layer 1 理解:  W0 Intent / P1 Scenario Analyzer / P2 Scenario Resolution
Layer 2 选择:  P3 Prompt Selector / P4 Prompt Generator / S2 Skill Judge / S4 Skill Final Selection
Layer 3 学习:  P5 Feedback Analyzer / S3 Skill Outcome / E1 Attribution Judge
规则层贯穿:    Retrieval / Validation / Composer / Dependency / Conflict / Version / Experiment / Evolution / Rollback
AI 提议，规则裁决，规则执行，Evolution 决定下一版。
```

## Glossary

- **W0 Intent Analysis**: 现有 `contextAnalyzer.callGeminiAnalysis`（gemini-3.5-flash），回答"用户要做什么"。
- **P1 Scenario Analyzer**: 新 Agnes-2.5-flash Worker，回答"任务发生在什么具体场景"，与 W0 真正并行。
- **P2 Scenario Resolution**: 新 Agnes-2.5-flash Worker，基于检索候选裁决 reuse/inherit/create 等。
- **P3 Prompt Candidate Selector**: 新 Agnes-3.0-flash Worker，选择/评估已有 Prompt 候选。
- **P4 New Scenario Prompt Generator**: 新 Agnes-3.0-flash Worker，仅在新场景且无合适 Prompt 时生成 experimental 候选。
- **P5 Outcome/Feedback Analyzer**: 新 Agnes-2.5-flash Worker，分析用户反馈"发生了什么"。
- **S1 Skill Semantic Understanding**: 新 Agnes-2.5-flash Worker，管理员上传/更新 Skill 后异步提取 capability/constraint/scenario tags。
- **S2 Skill × Scenario Compatibility Judge**: 新 Agnes-2.5-flash Worker，判断 Skill 对当前场景语义适配性。
- **S3 Skill Outcome Analyzer**: 新 Agnes-3.0-flash Worker，分析本次实验中 Skill 是否受影响（场景维度）。
- **S4 Skill Final Selection**: 新 Agnes-3.0-flash Worker，结合 S2 输出 + 权限/版本/实验约束，确定本次启用的 Skill（允许空选）。
- **E1 Attribution Judge**: 新 Agnes-3.0-flash Worker，基于 P5+S3 输出做归因（系数，不是最终 success_rate）。
- **Resolved Scenario**: P2 输出的最终场景决议（六态：reuse_exact / inherit_existing / create_child / create_new / merge_candidate / split_candidate）。
- **Compatibility Matrix**: `ScenarioPromptCompat` / `ScenarioSkillCompat` 两张矩阵表，只存 (scenario, asset) 二元维度，不存在全局单列 asset 质量分。
- **experimental Prompt**: P4 生成的新 Prompt 版本，status 固定 experimental，不可直接 stable。

## Requirements

### R1 — P1 必须与 W0 真正并行

**User Story:** 作为 Runtime，我要 P1 不依赖当前请求刚生成的 W0 结果，so that 两条理解链物理并行、总延迟降低。

Acceptance Criteria:
1. WHEN 请求进入 Prompt/Skill Runtime，系统 SHALL 同时发起 W0（gemini-3.5-flash）与 P1（Agnes-2.5-flash）两个调用（Promise.all）。
2. P1 的输入 JSON SHALL 仅包含：user_message、conversation_history（最近 5 条）、region、language、cached_intent（上一请求或历史缓存的 W0 结果，可选）、known_scenario_signatures（检索层轻量提示）。
3. P1 的输入 JSON SHALL 不包含本请求 W0 的实时输出字段。
4. P1 与 W0 的结果 SHALL 在 "Context Merge" 阶段合并（P1 的 scenario_signature + W0 的多维分类），合并结果进入 Scenario Retrieval。
5. IF P1 调用超时（8s）或 JSON 解析失败，系统 SHALL 标记 `degraded: true`，跳过 P2 的 AI 裁决，直接用 W0 的 domains/tasks 拼规则 scenario_signature 继续后续链路。

### R2 — W0 与 P1 职责不重叠

1. W0 SHALL 继续输出 MultiDimClassification（保留现有维度），其角色限定为"用户要做什么"。
2. P1 SHALL 输出 scenario_signature + intent/domain/object/goal/constraints/output/capability/knowledge/tool/risk/freshness/contextual_features（"具体在哪个场景干"）。
3. P1 SHALL 不重复输出 W0 已有且语义相同的 taskType 枚举字段。

### R3 — Scenario Retrieval 语义化

1. Scenario Retrieval SHALL 同时使用 scenario_signature、primary_intent、domain、object、contextual_features、父场景路径、tags 做候选召回（规则层，零模型成本）。
2. Scenario Retrieval SHALL 返回 Top-N（N 默认 10，可配），附每个候选的命中原因（signature_hit / keyword_hit / path_prefix / parent_fallback）。
3. Scenario Retrieval 的输出 SHALL 作为 P2 的唯一场景候选输入；P2 SHALL 不接触全库场景列表。

### R4 — P2 六态裁决与执行分离

1. P2 的 `resolution` 字段取值 SHALL 限定为：reuse_exact、inherit_existing、create_child、create_new、merge_candidate、split_candidate。
2. P2 SHALL 不执行任何数据库写操作；执行由规则层完成：
   - create_child / create_new → 规则层创建 `Scenario(status='experimental', origin='ai_suggested', parent_id, path)` + `ScenarioRelation.inherited_from`；
   - merge_candidate / split_candidate → 规则层只写 `EvolutionCandidate(targetType='scenario')`，不直接改库。
3. P1 输出的 `new_scenario_candidate.is_new` SHALL 只作为假设传给 P2；P2 结合检索候选裁决后，规则层才决定是否真正创建。
4. IF 检索命中 similarity > 0.8 的已有场景，P2 SHALL 优先输出 inherit_existing 或 create_child（绑定 inherited_from），输出 create_new。

### R5 — P3 两阶段选择（硬门槛 + Exploit/Explore）

1. P3 输出每个候选的 `fit_level` SHALL 限定为：high_fit / medium_fit / experimental_fit / low_fit / reject。
2. 规则层第一阶段硬门槛：
   - fit_level = reject → 永不进入 selected、永不进入 experimental；
   - fit_level = low_fit → 默认不进入生产、不 Explore；
   - 版本状态非法 / 权限不足 / 与场景冲突 → 排除；
   - category IN ('safety','privacy') 或 atom = 'core.truth_standard' → 不允许被 P3 的 delta 修改（规则白名单，写死代码）。
3. 规则层第二阶段 Exploit/Explore：
   - Exploit 候选：high_fit 且 unique_user_count >= 5 且 correction_rate 低于阈值；
   - Explore 候选：experimental_fit（或 medium_fit 且样本不足）且无负面证据，数量上限 K（默认 1）。
4. P3 SHALL 不输出使用次数（usage_count）作为加权项；实验次数与样本量只作为"证据充分度"进入门槛判断，不作为质量加分。
5. IF P3 输出 `no_suitable_prompt=true` 且 P2 resolution IN ('create_new','create_child')，系统 SHALL 调用 P4。

### R6 — P4 生成约束

1. P4 生成的 Atom/Version SHALL 以 status='draft' + version='*-experimental' 落库，不 publish。
2. P4 输出 15 字段 Schema（asset_type / purpose / scenario_id / scenario_tags / parent_scenario / applicable_conditions / required_behavior / constraints / output_expectation / tool_expectation / knowledge_expectation / verification_expectation / conflict_notes / inheritance_source / version_reason / experiment_hypothesis）。
3. P4 生成内容 SHALL 不包含 Core Identity / Safety / Privacy / Truth Standard 的改写。
4. 新 Prompt 初始 compatible 范围 SHALL 仅为目标 Scenario；后续由 Evolution 按实验结果扩展到新 Scenario（不锁死）。
5. P4 落库时 SHALL 同步创建 `ScenarioPromptCompat(scenario, atom, success_rate=0.5, experiment_count=0)` 占位行。

### R7 — P3 与 S2 并行

1. P2 完成后，系统 SHALL 同时发起 Prompt Retrieval + Skill Retrieval（检索层并行）。
2. Prompt 候选与 Skill 候选就绪后，系统 SHALL 以 Promise.all 并行调用 P3（Agnes-3.0-flash）与 S2（Agnes-2.5-flash）。
3. S2 完成后调用 S4（Agnes-3.0-flash）做最终 Skill 选择；P4 仅在 R5.5 条件满足时串行于 P3。
4. P3/P4 与 S2/S4 的结果汇合后 SHALL 进入规则 Composer（Dependency → Conflict → composePrompt），最终 System Prompt 只能由规则系统产出。

### R8 — Skill 选择保留 AI 语义判断，且允许空选

1. S2 SHALL 回答"该 Skill 对当前场景语义上是否适配"，输入包含 S1 产出的 capabilities/constraints/scenario_tags 与 ScenarioSkillCompat 历史数据；历史数据是辅助而非唯一依据。
2. S2 的 `decision` 取值 SHALL 限定为 use / experimental / reject / none；`none`（没有任何 Skill 足够适合）是合法结果。
3. S2 对"语义相似但能力不匹配"的候选 SHALL 输出 reject（例：React Frontend Skill 之于 Android 调试场景）；对"相关但证据不足"的候选 SHALL 输出 experimental，不以语义相似直接判 use。
4. S4 的 `selected_skill_ids` SHALL 允许为空数组；不强制 knowledge_base、不因"非闲聊"强制任何 Skill。
5. S4 SHALL 检查候选间的互补性/重复性/冲突/token 成本/实际必要性；两个功能重复的 Skill SHALL 不同时选用。
6. S4 SHALL 输出 `rejections[]`（每个未选 Skill 的原因）与 `empty_selection` 布尔标记，写入 SelectionDecision；`empty_selection=true` 时 `selected_skill_ids` 必须为 []。
7. 现有 `compiler.discoverSkills` SHALL 降级为纯 fallback：仅当 S2+S4 调用链异常时执行；正常路径不运行，其结果不参与拼装。
8. Skill 失败归因 SHALL 只更新对应 (skill, scenario) 的 ScenarioSkillCompat，不修改 Skill 全局质量分（Skill 表不新增全局 score 列）。
9. WHEN S1 完成语义理解，规则系统 SHALL 将结果写入 Skill 表元数据列并建 `SkillScenarioLink` 初始候选；链接标记 autoDerived=true，后续由真实实验持续修正，S1 输出不是最终固定值。
10. 父场景已有 Skill 经验时，新场景 SHALL 继承其 `ScenarioSkillCompat` 作为先验（initial prior），先验值 SHALL 标记 inherited=true，不视为已验证证据；新场景必须通过自身真实实验确认。

### R8b — S3 因果区分：Skill × Scenario 而非 Skill 全局

1. S3 SHALL 以"该 Skill 是否真的适合该 Scenario"为唯一评估问题，评价单位是 (skill, scenario) 二元组而非 Skill 本身。
2. S3 的 `impact` 取值 SHALL 限定为：skill_helped / skill_harmed / skill_irrelevant / skill_uncertain / scenario_wrong / prompt_wrong / output_wrong / requirement_changed / mixed_cause。
3. WHEN 用户纠正由 Prompt 输出约束导致（如 Prompt 强制简短回答而用户要求详细分析，Skill 本身提供的能力方向正确），S3 SHALL 识别为 prompt_wrong，该次信号 SHALL 不计入该 (skill, scenario) 的负面证据。
4. S3 的 `compatibility_adjustment_direction` SHALL 限定为 increase / decrease / unchanged / uncertain，作为方向性建议交给规则引擎；S3 SHALL 不直接写 ScenarioSkillCompat.success_rate。
5. S3 输出 SHALL 包含 `prompt_signal` 与 `scenario_specific_signal` 两个分离字段，供 E1 区分 Skill 问题、Prompt 问题与场景识别问题。

### R9 — S1 只在 Skill 入库/更新时运行

1. WHEN 管理员 POST /skills 或 ZIP 导入成功，系统 SHALL 写入 `Skill.analysisStatus='analyzing'` 并 enqueue `SkillAnalysisJob`。
2. workerPool 执行 S1 后 SHALL 只写 capabilities / constraints / scenario_tags / not_applicable_scenarios / rationale 五个字段，永不写 Skill.prompt 正文。
3. Skill 内容（prompt/description）变更时 SHALL 以 `version+1` 记录并重新 enqueue 分析 job。
4. S1 提取的 scenario_tags SHALL 写入 `SkillScenarioLink`（含 confidence + rationale + autoDerived=true）。

### R10 — P5 / S3 / E1 三段分离的反馈闭环

1. WHEN 检测到用户后续消息且存在关联的 SelectionDecision，系统 SHALL 并行调用 P5（"发生了什么"）与 S3（"Skill 在本次实验中是否受影响"）。
2. P5 输出 11 字段 Schema（outcome / positive_signals / negative_signals / corrections / accepted_parts / rejected_parts / new_requirements / scenario_change_signal / prompt_change_signal / skill_change_signal / confidence）；P5 SHALL 不产生归因系数。
3. S3 输出 per-skill 评估（impact / impact_scope / signals / confidence）；S3 的 impact_scope SHALL 限定为 scenario_specific 或 unknown，不使用 global。
4. P5 与 S3 均完成后，系统 SHALL 调用 E1（Agnes-3.0-flash）产出 `attribution: { prompt, skill_X, scenario, model, output_format }` 带符号系数 + primary_cause + secondary_causes + evolution_actions。
5. E1 的系数 SHALL 作为输入交给规则统计引擎：规则系统按当前样本量、历史数据、跨用户证据、时间衰减、置信区间计算新的 compatibility 值并写矩阵；AI SHALL 不直接写 success_rate。
6. 单用户证据 SHALL 不满足晋级门槛（evidence_strength 公式中 unique_user_count 项封顶，单用户无论实验多少次都无法达到 stable 门槛）。

### R11 — 实验记录

1. 每次真实使用 SHALL 记录 `ExperimentRun`：decision_id、user_id、scenario_id、atom_versions、skill_versions、model、feedback_signal、outcome、attribution_ref、experiment_type(real|synthetic)。
2. `SelectionDecision` SHALL 记录：scenario_id、secondary_scenario_ids、selected_atom_ids、selected_skill_ids（可为空）、prompt_compat_snapshot、skill_compat_snapshot、model、outcome。
3. synthetic 类型数据 SHALL 不计入 unique_user_count 统计。

### R12 — Evolution 扩展与受控区

1. `EvolutionCandidate.targetType` SHALL 扩展支持 prompt_version / skill / scenario。
2. targetType 为 skill 或 prompt_version 的候选 SHALL 强制 adminApproveCandidate（绕过 canary 直连 promoted 的隐式路径）。
3. Core Identity / Safety / Privacy / Truth Standard / 权限规则 SHALL 对 Scenario Evolution 只读：普通反馈只能形成 Candidate/Evidence，不能直接修改生产资产。
4. canary 百分比 SHALL 有真实流量侧生效逻辑（按 canaryPercent 选择 experimental vs published 版本），不得再是死字段。
5. 版本晋级/回滚 SHALL 由规则系统执行（证据强度公式 + 管理员审批），AI Worker 只产出 hypothesis/evidence。

### R13 — 无限 Scenario 增长的性能约束

1. 所有 AI Worker 的输入候选集 SHALL 有上限：场景 ≤10、Prompt ≤20、Skill ≤15（可配，默认值保守）。
2. Worker 的 prompt token 消耗 SHALL 为常量级，不随库总量增长。
3. Scenario 表 SHALL 对 path / parent_id / category+status 建索引；检索用前缀匹配 + 关键词，不依赖向量索引（embedding 字段预留不填值）。
4. 兼容矩阵的冗余计数（experiment_count / unique_user_count）SHALL 由后台定时重算 job 维护，请求路径不做全表 DISTINCT 聚合。

### R14 — 主链唯一权威结果与 fallback

1. 新链（P1→P2→P3/P4/S2/S4→Composer）成功时，最终 System Prompt SHALL 只来自规则 Composer，旧 compiler 的 skill 段落不参与拼装。
2. 仅当新链异常（超时/模型不可用/JSON 解析失败）时 SHALL 逐级降级：P1 失败→跳过 P2 走规则场景映射；P3 失败→规则检索层直接选 atom；S2/S4 失败→discoverSkills 兜底（SelectionDecision 标记 fallback_reason）；全链失败→旧 compiler 完整路径。
3. 每条降级 SHALL 在 trace 中记录 `source` 与 `fallback_reason`，用于后续统计区分 AI 选择与规则兜底的信号权重。

## Notes

- 第一版不做"简单请求跳过 P1/P2 的 Fast Path"，先保证场景经验数据连续积累；待 Trace 统计成熟后按证据裁剪。
- P1/W0 并行成本（每请求一次 Agnes-2.5-flash）在第一版接受，不优化。
- 架构决策记录（ADR-1）：Skill 选择保留 AI（S2+S4），纯规则仅作 fallback；E1 独立于 P5/S3；P1 不依赖本请求 W0 输出。

## Implementation Status

4 项实现项已全部落地（代码已提交到 server）：

| 项 | 状态 | 实现位置 |
|---|---|---|
| **AI 不直接发布正式 Skill** | ✅ 已实现 | `services/skillPublishGuard.ts`（`guardSkillPublication` + `assertNoGlobalSkillQualityWrite`）；admin routes `routes/knowledge.ts` POST/PUT /skills + `services/importService.ts` ZIP 导入 全部走 guard；`ai_generated`/`auto_derived`/`unknown` 来源一律拒绝。 |
| **实际 Worker 调用** | ✅ 已实现 | `services/scenarioWorkers/` 全 10 Worker（P1-P5 + S1-S4 + E1）+ 共享 `agnesCaller.ts`（池化 key + 429/5xx 重试 + 超时 + 枚举白名单校验）。S1 经 `services/skillAnalysisWorker.ts` 接入 workerPool（新 `skillAnalysis` job kind）。 |
| **数据库 migration** | ✅ 已实现 | `prisma/schema-knowledge.prisma`：Skill 加 S1 九列 + version/analysisStatus；Scenario 加 path/parent_id/status 扩展/origin；新增 7 表 `ScenarioRelation`/`ScenarioPromptCompat`/`ScenarioSkillCompat`/`SkillScenarioLink`/`SelectionDecision`/`ExperimentRun`/`AttributionRecord`。`prisma/schema-user.prisma`：新增 `SkillAnalysisJob`。全部 `db push` 已应用 + client 已生成。 |
| **Runtime 真正接入** | ✅ 已实现 | `services/scenarioRuntime.ts`（`runScenarioRuntime` 编排）；`services/promptRuntime.ts` 按 `CORTX_SCENARIO_RUNTIME` flag 灰度接入（默认 off）；`routes/chat.ts` 在 flag on 时以 S4 `selectedSkillIds` 为权威 skill 源，`discoverSkills` 降级为纯 fallback。 |

### 验证结果

- `npx tsc --noEmit`：0 error；`npm run build`：通过
- `test/scenarioRuntime.test.js`（契约）：18/18
- `test/scenarioRuntime.e2e.js`（降级 smoke）：6/6
- 既有 `test/knowledgeLifecycle.test.js`（30/30）+ `test/knowledgeLifecycle.e2e.js`（17/17）回归全绿

### 灰度与回滚

- `CORTX_SCENARIO_RUNTIME` 默认 **off**：关闭时不跑新链，chat 走原 `discoverSkills` 路径，行为与旧版一致（R14.8）。
- 开启后全链失败自动回落 legacy compiler（R14.2），单点降级不阻塞请求。
