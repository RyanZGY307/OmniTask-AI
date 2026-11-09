# cortex 集成交接手册 v2 —— 快照存档

> 本文件是快照存档，供 GitHub 仓库自包含交接使用。
> 唯一可编辑来源：`OmniTask-Agent-workspace/OmniTask-Agent/docs/integration/CORTEX_INTEGRATION_RUNBOOK.md`（agent 仓库 commit 0d95968，已推送私有仓库 RyanZGY307/OmniTask-Agent @ a0bfcd4）。
> 若两者冲突，以 agent 仓库来源为准；本快照仅用于下一任 Agent 在无 agent 工作区时快速理解 S1–S6。

---

# cortex 集成交接手册（主项目 AI 执行版）· v2（2026-11-03 修订）

> **修订起因**：主项目 AI 按 v1 §0 执行前置确认，如实回报 5 项与预期不符并停下（完全正确，符合手册纪律）。
> OmniTask-Agent 研究侧**只读复核**了 cortex 源码（不下写），确认其回报基本属实，并**修正了其中 1 项误报**（见 §0.2）。
> 本版把 5 项不符全部落成修订后的前提；凡标「已核实（只读证据）」的可直接用，凡标「待宿主实测」的仍需 §6 回报消号。
>
> **分工（用户 2026-10-21 明令 + 2026-10-23 确认）**：OmniTask-Agent 仓库只写自身源码；cortex 侧的写入由**主项目 AI 按本手册执行**。
> **口径纪律**：凡标「未验证」的条目，不得在回报或产品文案中写成已验证；实测后由本仓库侧把对应能力从 `unverified` 升级为 `runtime_observed`。

---

## 0. 前置确认（只读，禁止先写）

主项目 AI 已跑过一轮（见用户转达的回报）。v1 的全部命令因**目录差一层**而落空，v2 起所有路径以 `OmniTaskAI/cortex/server/` 为根（下文一律简称 `server/`）。

### 0.1 宿主工程形态（已核实：只读证据）

verification note：以下每条都是 OmniTask-Agent 侧**只读 grep/读文件**所得，主项目 AI 可直接采信；若与实际不符（例如不同分支），以实际为准并回报偏差。

| 项 | 事实 | 证据 |
|---|---|---|
| Prisma 布局 | `server/prisma/`：**5 个 schema-file + 8 个裸 SQL 迁移文件**，无 `migrations/` 目录 | `server/prisma/` 目录清单 |
| Prisma client | 每个 schema 有**独立 output**（`@prisma/client-user` 等）——**多 client 并存，不是单 client** | `schema-user.prisma` generator 块 |
| 数据源 | 每 schema 独立 datasource + 独立 env URL（`DATABASE_URL_USER/_KNOWLEDGE/...`） | `schema-user.prisma` datasource 块；`config.ts:32-33` |
| 迁移应用 | `server/scripts/applyMigrations.js`：读 4 个 SQL 文件→各自 URL，**先整批后逐语句**，容忍 `already exists`（42P07） | `scripts/applyMigrations.js:7-12,38-60` |
| npm 脚本 | 只有 `prisma:generate`（5 个 schema 各一条）+ `prisma:migrate:user`/`:knowledge`（仅 2 个 schema 有） | `server/package.json:7-10` |
| 模型路由 | `chatWithFallback` 在 `server/src/services/models.ts:7`，是 **`async function*` 流式生成器** | 签名实读 |
| 路由模块 | `routeModel` **存在**于 `server/src/services/router.ts:59`（v1 回报「不存在」系 grep 落空目录所致，见 §0.2） | grep 命中 |
| 模型注册表 | `MODEL_REGISTRY` 在 `server/src/config.ts:85`，**不在** models.ts | grep 命中 |
| SSE | 两处 text/event-stream，帧为 `data: ${JSON.stringify({type, content})}`（`'accepted'`/`'error'`） | `routes/chat.ts:900,909,915,1612,1621` |
| 审批引擎 | `server/src/connections/permissionEngine.ts`，分级 **R0–R4**，默认 `auto/auto/confirm/confirm/never`，**R4 永不允许 auto**（用户设了也被压回 confirm） | `permissionEngine.ts:21-25,38-39` |
| MCP | `server/src/connections/connectors/mcp/client.ts`（真 client） | 目录清单 |
| 工具调用 | `chatWithFallback` **无 tools 参数、不产出 tool_calls**；`modelRequestBuilder.ts` 有 tools 能力但只接单轮 system+user（无历史、无 tool 结果位） | `models.ts:7-13` 签名；`modelRequestBuilder.ts:25-41,84-87` |

### 0.2 对主项目 AI v1 回报的一处更正（诚实纪律）

主项目 AI 报「`src/router.ts` 不存在；`routeModel` 全仓 0 命中」——**不成立**。其 grep 落在 `cortex/src/`（v1 手册给的错路径），而实体在 `cortex/server/src/services/router.ts:59`，`routes/chat.ts:21` 等 4 处 import 使用。**其余 4 项不符全部属实**（P1/P3/P4/P5 方向正确，P5 只是路径差一层）。

> 教训入库：路径差一层会让 grep 全集落空，「0 命中」≠「不存在」。两侧都用绝对/实测路径复核后再下结论。

### 0.3 修订后的 §0 复检命令（若主项目 AI 想自跑）

```bash
cd server
ls prisma/                                   # 5 schema + 8 sql
grep -n "chatWithFallback" src/services/models.ts | head -2      # 期望 :7 (async function*)
grep -n "routeModel" src/services/router.ts | head -2            # 期望 :59
grep -n "modelRequestBuilder" src/services/promptRuntime.ts      # 期望 :13,:268
grep -n "R0\|R4" src/connections/permissionEngine.ts | head -4   # R0 auto / R4 never
node scripts/applyMigrations.js              # 幂等基线（连 4 个库；agent 未加 TARGET 前不动）
```

---

## 1. 文件映射表（本仓库 → cortex 侧落点）

原则不变：**契约类直接 import 或整体复制；实现类按宿主形态重写一薄层；绝不复制第二套模型客户端/提示体系/MCP 栈/凭证体系**。

| 本仓库文件 | 性质 | cortex 侧处置（v2 修订） |
|---|---|---|
| `prisma/schema-agent.prisma` | 数据模型 | 合入宿主 Prisma 工程时**保持既有范式**：本 schema 已是独立 generator output `@prisma/client-agent` + 独立 datasource `DATABASE_URL_AGENT`，与宿主 5-schema 范式**一致**，直接 sibling 放置 |
| `prisma/migrations-agent/0001_init.sql` | 迁移（**幂等已核**：13×`CREATE TABLE IF NOT EXISTS` + 10×`CREATE INDEX IF NOT EXISTS` + 0 个 DO 块） | 复制为 `server/prisma/migrations-agent.sql`（对齐宿主命名），在 `scripts/applyMigrations.js` 的 TARGETS 加第 5 项（见 S1） |
| `src/events/types.ts`、`src/events/ids.ts`、`src/model/protocol.ts` | 纯契约/纯函数 | 整体复制 |
| `src/events/sqliteEventStore.ts` | L1/L2 用实现 | 不复制到生产；宿主按 `EventStore` 接口写 Prisma/Postgres 实现（注意宿主 DB 是**按层分库**，agent 事件落 agent 库） |
| `src/events/projection.ts` `sse.ts` | 纯函数 | 整体复制；但 `sse.ts` 的 `encodeFrame` **不复用为宿主帧格式**——见 S2 |
| `src/model/types.ts`、`src/model/capability.ts` | 契约 + 能力词表 | 整体复制；contextWindow 以宿主 `MODEL_REGISTRY` 为准（差值是 S3 回报项） |
| `src/model/scriptedClient.ts` | 测试替身 | 只进测试，不进生产 |
| `src/model/nvidiaNimClient.ts` | **真实供应商客户端（参考实现）** | 宿主侧 S3 优先走 §S3 的「复用 chatWithFallback」方案；本文件作为「直连供应商」备选方案的参照（含错误归类/usage 四分类/能力观测升级） |
| `src/policy/`（3 文件） | 判定 + 状态机 | 整体复制；**r0–r3 ↔ R0–R4 映射表**见 S4（已按实读默认值写好） |
| `src/tools/`（含 index.ts 统一入口） | 工具层 | 复制；**宿主 bash 是服务端 shell**，须复核 `SHELL_META` 白名单在 bash 下的行为（未变） |
| `src/runtime/patterns/`（9 文件） | 7 架构 Runner | 整体复制；Free=3 / Pro=7 档位门禁已在本侧实现并通过测试 |
| `src/runtime/agentLoop.ts` `runner.ts` | 派发器 + 执行原语 | 复制；宿主侧把 `EventStore`/`ModelClient` 换成宿主实现 |
| `src/runtime/compactor.ts` `guard.ts` | 压缩 + 预算护栏 | 复制；`protectedOld` 保护语义必须原样保留（红线） |
| `src/runtime/checkpoint/` `subagent.ts` `skills.ts` `advisor.ts` | M3 能力 | 复制；`advisor` 走宿主 `chatWithFallback` 的独立调用 |
| `src/runtime/mcp.ts` | 宿主适配器契约 | 契约复制、实现由宿主注入（宿主已有真 MCP client：`server/src/connections/connectors/mcp/client.ts`） |
| `src/ui/taskView.ts` | UI 投影（纯函数） | 复制；React 组件按 `TaskCardVM` 字段映射，**不得本地推断未送达事件** |
| `test/*.test.ts`（30 文件 191 例） | 验收 | 并入宿主 CI；口径见 §5 |

---

## 2. 分步执行（每步：动作 → 验证 → 回退）

> 每步独立提交；任何一步验证失败即停，回退该步，回报。

### S1 数据层（Prisma + 裸 SQL）

**背景（v2 重写）**：宿主**不用** `prisma migrate deploy`，而是「按层分库 + 裸 SQL + `scripts/applyMigrations.js`」。agent 层照此办理。

**动作**：
1. 把本仓库 `prisma/schema-agent.prisma` 复制为 `server/prisma/schema-agent.prisma`（**不改 generator output / datasource 名**，与其余 5 个 sibling 一致）；
2. 在 `server/package.json` 的 `prisma:generate` 末尾追加 `&& prisma generate --schema prisma/schema-agent.prisma`；
3. 把 `prisma/migrations-agent/0001_init.sql` 复制为 `server/prisma/migrations-agent.sql`；
4. 在 `server/scripts/applyMigrations.js` 的 `TARGETS` 数组加一项：
   ```js
   { name: 'agent', url: process.env.DATABASE_URL_AGENT, sql: 'prisma/migrations-agent.sql' },
   ```
5. 配好 `DATABASE_URL_AGENT`（**独立库**；与 `DATABASE_URL_USER` 等同级，勿混用）；跑 `node scripts/applyMigrations.js`。

**验证**：
```bash
cd server
npx prisma generate --schema prisma/schema-agent.prisma                 # 期望: 无错，产出 @prisma/client-agent
node scripts/applyMigrations.js                                        # 期望: [agent] migration applied (batch) 或逐语句无 error
node scripts/applyMigrations.js                                        # 重跑一次 → 期望仍然成功（幂等重放）
node -e "const c=require('./node_modules/@prisma/client-agent');console.log(Object.keys(c).length>0||true)"
# 表清点（psql 或任何客户端）：期望 12 张（Task/Run/Step/Event/ModelCall/ToolCall/Approval/UserInputRequest/Checkpoint/Artifact/Todo/PermissionRule）
```
**回退**：删除 `TARGETS` 的 agent 项 + 删除两个新文件 + `DROP TABLE` 12 张；**本仓库侧不用改**。
**注意**：`Event`/`ModelCall`/`ToolCall` 三个模型名与宿主既有 schema 的模型名**同名**。因宿主按 schema 分 client（`@prisma/client-agent` 独立），**生成层不冲突**；但若 `DATABASE_URL_AGENT` 与任一宿主层指向**同一库**，表名会真冲突——**这是必须回报的实测项**：agent 库是否独立。

### S2 事件通道（SSE）

**背景（v2 重写）**：宿主现有帧是 `data: {type:'accepted'|'error', content}`，与本仓库 `sse.ts` 的 `encodeFrame` **不是同一格式**；且 `type` 命名空间已被宿主占用（`accepted`/`error`…）。

**动作**：宿主 SSE 通道新增 agent 帧族，**与现有帧共存不替换**，用独立事件名防撞：
```js
// 宿主写帧处（chat.ts:909 同款位置）新增分支：
res.write(`data: ${JSON.stringify({ type: 'agent_event', seq: e.seq, eventType: e.type, payload: e.payload })}\n\n`);
```
- 事件类型词表**逐字采用**本仓库 `src/events/types.ts`（不增删改名）；
- `eventType` 即 `e.type`（`run.created`/`pattern.selected`/`tool.requested`…），不进宿主 `type` 命名空间。

**验证**：宿主侧最小用例：`AgentLoop.start()`（**用本仓库 `scriptedClient` 替身，不需要真模型**）→ SSE 客户端收到 `agent_event` 帧若干，`eventType` 依次为 `run.created`/`pattern.selected`/`run.started`/…且 `seq` 连续无洞；现有 `'accepted'`/`'error'` 帧行为不变（回归）。
**回退**：SSE 扩展点 revert；不影响其它步骤。

### S3 模型适配（**Q1 实测点，本手册最高风险项**）

**背景（v2 重写，这是本次修订的核心）**：`chatWithFallback(messages, modelKey, maxTokens, temperature, availableModels)` 是**流式异步生成器**，产出形如：
```
{type:'chunk', content, model}      // 增量文本
{type:'usage', usage:{prompt_tokens, completion_tokens, total_tokens, completion_tokens_details:{reasoning_tokens}}}  // 结束前一条，供应商口径
{type:'model_switch', model}        // fallback 换模型（Router 的备选顺序）
{type:'done', model[, tokens]}      // 结束
{type:'error', content}             // 失败文案（面向用户，不含内部模型名）
```
且**没有 tools 参数、不产出 tool_calls**。工具调用能力在宿主另一条路径（`modelRequestBuilder`+`promptRuntime`），但它只接受**单轮 system+user、无消息历史、无 tool 结果位**，不足以驱动 AgentLoop 多轮工具循环。

**因此 S3 采用「复用 chatWithFallback 作传输 + Action 文本协议作工具通道」**（约 60–90 行，非 30 行——此前低估）：

```ts
// 概念形态（宿主侧实现，薄层）
class HostModelClient implements ModelClient {   // 契约 = src/model/types.ts
  async chat(req: ChatRequest): Promise<ChatResult> {
    let text = ''; let usage: UsageBlock = USAGE_UNAVAILABLE();
    let actualModel = req.modelRef.modelKey; let switched = false; let offline = false;
    for await (const ev of chatWithFallback(toOai(req.messages), modelKey, req.maxOutputTokens ?? 4096, 0.2, fallbacks)) {
      if (ev.type === 'chunk') text += ev.content ?? '';
      if (ev.type === 'usage' && ev.usage) usage = { input: ev.usage.prompt_tokens, output: ev.usage.completion_tokens, reasoning: ev.usage.completion_tokens_details?.reasoning_tokens, source: 'provider', precision: 'exact', raw: ev.usage };
      if (ev.type === 'model_switch') { switched = true; actualModel = ev.model; }
      if (ev.type === 'done' && ev.model === 'offline-mock') offline = true;
      if (ev.type === 'error') return errorResult('bad_request', ...);
    }
    const parsed = parseActionProtocol(text);     // 本仓库 src/model/protocol.ts（7 例测试锁定，勿改）
    return { text: parsed.residualText, toolCalls: parsed.calls, usage,
      capabilitySnapshot: this.describe(req.modelRef),   // evidence 按 R-01 如实标 host_registry
      modelRef: { tier: req.modelRef.tier, modelKey: actualModel, provider: 'host' },
      finishReason: parsed.calls.length ? 'tool_calls' : 'stop',
      latencyMs: measured,
      // R-11：离线兜底不是真实模型调用 → 必须标 simulated，事件流据此判 R5
      ...(offline ? { simulated: true } : {}),
      degraded: [switched ? { kind: 'fallback_used', detail: actualModel } : null, parsed.errors.length ? { kind: 'tools_prompt_protocol', detail: parsed.errors[0] } : null].filter(Boolean) };
  }
}
```
四条硬约束在适配器里的落点（对应 §3 禁止事项，逐条自查）：
1. **R-02 用量四分类**：`type:'usage'` 存在 → `source:'provider'`；缺失 → `unavailable`（禁填 0）。宿主离线兜底已诚实记 `tokens: 0`（`models.ts:71` 注释自证），适配器遇 `offline-mock` 直接 `simulated`+usage 记 unavailable，**不得把 offline-mock 当真实 provider**。
2. **R-11 红线**：`offline-mock` / 离线回复必须标 `simulated`——否则 L4 R5 门禁判 violated（本仓库 `test/redlines.test.ts` 已锁定该行为）。
3. **R-01 能力不伪造**：宿主 `MODEL_REGISTRY` 的 contextWindow 是 `host_registry` 级证据；未实观测前 `describe()` 不得标 `runtime_observed`。
4. **`model_switch` = fallback**：必须反映到 `modelRef.modelKey`（实际模型）与 `degraded`，不得仍报请求模型名。

**必须实测并回报的四项（v1 的 Q1 四问，答案已部分由只读核实给出，仍需运行时确认）**：
1. **usage 透传**：只读已见供应商 usage→`{type:'usage'}` 归一化（`prompt_tokens`/`completion_tokens`/`reasoning_tokens`；Gemini 也在 `models.ts:281-286` 归一成同形）。**待确认**：`costUsd` 宿主是否另有计价源（`billing/tokenBilling.ts` 见到用量消费，需回报其字段名）。缺项 → `UsageBlock` 对应字段记 `estimated` 或 `unavailable`，禁 0。
2. **流式**：**已核实支持**（host 是流式生成器）。适配器聚合为 `ChatResult`（AgentLoop 非流式消费）；`streaming` 能力按实标。
3. **tool-calling**：**已核实 chatWithFallback 无原生工具调用** → 走本仓库 Action 协议（方案 B，7 例测试锁定）。**回报项**：宿主是否有计划让 agent 直连带 tools 的路径；若无，本路线即终态。
4. **contextWindow 真实值**：**待回报**：宿主 `MODEL_REGISTRY` 各模型 contextWindow 与本仓库 `src/model/capability.ts` seed 的差値表；不一致以宿主为准，本仓库侧改 seed。

**验证**：①适配器单测（注入 fake `chatWithFallback` 迭代器：正常/离线-mock/model_switch/usage 缺失四路）；②用本仓库 `test/nvidiaNim.test.ts` 的 L5 同构用例跑一条宿主真实调用冒烟（**打码日志，不打印 key**）；③ `test/redlines.test.ts` 的 R5/R1 在该路径不误报。
**回退**：适配器删除；本仓库侧把 Q1 记为「未解决，走文本协议」（设计已预留，不算返工）。

### S4 策略与审批（与宿主 permissionEngine 对齐）

**背景（v2 重写）**：宿主分级 **R0–R4**，默认 `R0:auto / R1:auto / R2:confirm / R3:confirm / R4:never`，且 **R4 即使用户设 auto 也被压回 confirm**（`permissionEngine.ts:38-39`），另有用户持久授权 `always`（prefix 粒度，走 `UserSetting.actionPolicies`）。

**动作**：映射表写进宿主 agent 模块（本仓库 `src/policy/risk.ts` 的 r0–r3 是源）：

| 本仓库 risk | 宿主 riskLevel | 宿主默认 | 约束（红线） |
|---|---|---|---|
| r0（只读） | R0 | auto | — |
| r1（低影响写） | R1 | auto | — |
| r2（外联/不可逆） | R2 | confirm | — |
| r3（neverAuto：外联资金/删除/发布类） | **R3 + 禁 auto 标记** | confirm | **宿主的 `always` 持久授权不得覆盖本仓库 r3**——r3 每次必须人工（本仓库 DEC-02：审批单 Run 有效）。宿主 R4 是「永不执行」语义，与本仓库 r3「每次需人批」不同，**不得**把 r3 映射到 R4 |

审批卡 UI 按 `approval.requested` 事件渲染（`summary` 字段即卡片文案）；`approval.decided.by` 必须为人类用户（宿主自动批准 = I3 红线违规，`src/ui/audit.ts` 已锁定）。

**验证**：`test/policy.test.ts` 11 例在宿主侧通过；一条端到端：r2 工具 → `waiting_approval` → 宿主 UI 出卡 → decide → resume（本仓库幂等恢复已修）→ completed。
**回退**：移除映射表，agent 侧策略判定暂以本仓库实现为准（记录偏差）。

### S5 UI（任务列表/详情）

同 v1：按 `src/ui/taskView.ts` 的 `TaskCardVM`/`summarizeEvent` 写组件；列表数据源 = `EventStore.getEvents(runId)`，**不允许前端另存一份任务状态**（唯一事实源纪律）。
**验证**：`test/ui.test.ts` 6 例 + 手动冒烟（建任务→跑→挂起审批→放行→完成，`TaskPhase` 11 态随事件翻转）。
**回退**：UI revert，不影响后端。

### S6 能力面开关

同 v1：宿主把 `AgentLoop.capabilities()`（`checkpoints/subagents/skills/advisor/mcp` 五布尔）映射到能力面板；**未注入的能力显示「不可用」，不得伪造**。

---

## 3. 禁止事项（宿主侧同样适用）

1. **不得建第二套**：模型调用层、系统提示体系、密钥体系、任务状态存储、MCP 栈、记忆/压缩分层——宿主已有的一律复用（ADR-011：MCP 走宿主真 client）。**S3 尤其注意**：适配器必须走 `chatWithFallback`（复用其 key pool / fallback / 限流），不得自建第二条供应商调用链（`src/model/nvidiaNimClient.ts` 只是研究侧参考实现，不是要宿主复制两份）。
2. **不得改 TextAction 协议形态**：`src/model/protocol.ts` 的 `action` 块是 7 例测试锁定的契约；接入失败先回报，不要就地改协议。
3. **不得动红线保护**：`compactor.ts` 的 `protectedOld`、`guard.ts` 的 neverAuto 五类、`pattern` 档位门禁的降级记录、`resume()` 的幂等跳过（`tool.replayed_skipped`）——都是已修 bug 的回归防线。
4. **不得 push / 建远端 / 提交凭证**（AGENTS.md 全局红线）。宿主的 `offline-mock` 兜底回复在 agent 链路里必须透记 `simulated`，不得当真实模型输出呈现给用户（与宿主 chat 链路的既有提示文案并存，不冲突）。

---

## 4. 未验证清单（v2 滚动消号）

| 项 | 现状（v2） | 谁验证 |
|---|---|---|
| Q1-1 usage 透传 | 只读**已核实**有 `type:'usage'`（prompt/completion/reasoning）；`costUsd` 来源**待确认** | S3 |
| Q1-2 流式 | 只读**已核实**支持（生成器） | S3 回报即可消号 |
| Q1-3 tool-calling | 只读**已核实** chatWithFallback 无原生；走 Action 协议（设计内） | S3 冒烟 |
| Q1-4 contextWindow | MODEL_REGISTRY 值**待回报差値表** | S3 |
| 宿主 SSE 帧扩展点 | 设计已定（`agent_event` 共存帧） | S2 |
| Prisma 多 schema 外键规范 | 软引用未加 FK；**agent 库是否独立库待回报** | S1 |
| 宿主 bash 的 argv 直执行 + 元字符白名单 | 本仓库按 toybox 实测；宿主 Linux 语义需复核 | S4 前 |
| MCP client 注入 | 契约就绪，宿主 client 路径**已核实存在** | S3 后 |
| Compactor 与宿主 memoryManager 分层关系 | 设计分层，未对齐实测 | S2 后 |
| 审批卡 UI 形态 | 事件契约就绪，无视觉稿 | S5 |
| 宿主 `always` 授权与 r3 的互斥 | 映射表已写死约束，**宿主实现行为待实测** | S4 |

---

## 5. 测试口径（回报必须写清）

本仓库当前 **191 例**（`node --test 'test/*.test.ts'`：190 通过 + 1 默认 skip 的 L5 真实供应商用例，需 `NVIDIA_L5=1`+key 才跑），分层：
- **L1 单元/替身级**（多数）：协议编解码、状态机、判定矩阵、7 Runner 控制流、UI 投影、NIM 适配器错误归类/用量四分类；
- **L2 集成冒烟**（`test/l2.test.ts`）：SQLite 持久化 EventStore + 真实文件系统 + 模拟供应商；
- **L5 真实供应商**（`test/nvidiaNim.test.ts` 第 7 例，默认 skip）：NVIDIA NIM 实跑过（nemotron-3.5-super-vl-120b-a12b），事件流 `usageSource=provider`/latencyMs 实测/L4 红线 `verdict=clean`；
- **明确没有**：宿主写入、宿主网络请求、宿主全链路。

宿主侧不得把 L1/L2 结果表述为「已通过真实模型验证」。

---

## 6. 回报模板（主项目 AI 按此回填）

```
步骤: S1 / S2 / S3 / S4 / S5 / S6
动作: <实际做了什么，改动文件列表>
验证: <命令 + 真实输出关键行，非结论>
偏差: <与手册预期不符之处，含路径:行号证据>
未验证残留: <本步没测到的>
建议: <是否需要本仓库侧改代码；如需要，说明改哪个文件哪个契约>
```

回报交回用户转达本仓库侧；本仓库侧据实测把能力状态从 `unverified` 升级为 `runtime_observed` 并修订契约默认值。
