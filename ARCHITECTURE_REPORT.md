# Cortex AI 平台 · 架构与功能详细报告

> 生成：2026-10-09 · 基于工作区 `~/workspace`（client + server）实际代码核实 + 会话/项目记忆。
> 未提交改动（git status）即为最近一轮开发成果，本报告反映**当前工作区状态**。

---

## 1. 项目概览

Cortex AI（「CortexAI，为你而生」）是一个 AI 助手 SaaS 平台：

- **双轨**：免费版（STANDARD，0 积分，后端自主选模+多 API 轮询）/ Pro 版（PRO/ULTRA，积分制，用户手动选模按 token 消耗积分）；
- **能力**：对话（流式/思考等级/深度研究）、多模型多供应商网关、图片/视频/TTS/Office 文档生成、双层知识库 + RAG、联网搜索、网页自动化（浏览器/token）、技能（Skill）体系、记忆与知识进化、语气学习、支付与动态定价；
- **前端** `client/`：Next.js 14 + Tailwind + Zustand，部署 **Vercel**；设计语言参考 Kimi/ChatGPT（极简、浅色软阴影/深色柔光、弹性动效）；
- **后端** `server/`：Node + Express + Prisma（4 个 PrismaClient），部署 **Render**（手动触发）；
- **数据库**：4 个独立 Layerbase Postgres（`user / conversation / knowledge / overflow`，pooler 会休眠，需唤醒，延迟 10–30s）；
- **AI 网关**：Agnes（`apihub.agnes-ai.com`，主力 `agnes-2.5-flash` / `agnes-3.0-flash`，**模型 id 必须小写**）+ Gemini / ChatGPT / DeepSeek / Xiaomi。

## 2. 系统架构

### 2.1 启动序列（`server/src/index.ts`，已核实）
1. `loadEnv` → `wakeDatabase(5)` 唤醒 4 库 + `startKeepAlive(60s)` 保活；
2. ensure 4 套 schema（`prisma db push` 管理的 schema-user/conversation/knowledge/overflow）；
3. `initDynamicConfig()`（模型/套餐/价格）+ `seedDefaultScenarios()`；
4. `loadProviderConfigs()` → `initApiKeyPools()`（DB 供应商连接优先，失败回退 env）；
5. `registerAllConnectors()` + `initVault()`（prod 强制 `VAULT_KEY`，dev 用不安全派生）；
6. 定价引擎 bootstrap + 每日任务（10s 错峰，避免 P2028/P1008 污染 /auth）；模型输出限额探测（24 天刷新，避开 Node 32 位定时器溢出坑）；
7. `initWorkerPool(5)` + 知识自愈调度器（10min tick，`KNOWLEDGE_LIFECYCLE_ENABLED` 可关）。

### 2.2 健康门控
`GET /api/health`：对 4 个 PrismaClient 各做 `SELECT 1`（5s 超时），全通才 200。前端根 layout 轮询它，**API 可达但某库挂 → 503 → 前端显示「连接失败，请稍后重试」，不进界面**（最近一次 commit `790e81f` 的行为：仅 404/不可达/DB-down 才拦截）。

### 2.3 Worker 池（`services/workerPool.ts`，单进程 in-process）
- 2s tick + 10s heartbeat + 5min 租约；启动先 `recoverStaleJobs`（租约过期回滚 QUEUED）；
- 按优先级认领 7 张 job 表：`researchJob > organizationJob > evolutionJob > refreshTask > skillAnalysisJob(S1) > modelProfileJob(M系列) > contextCompressionJob`；
- 各 job 动态 import 对应 executor（researchExecutor / orgRuntime / evolution / refreshWorker / skillAnalysisWorker / modelProfileJob / contextMemory 压缩 worker）。

## 3. 功能地图（路由 ↔ 子系统）

| 功能域 | 路由前缀（鉴权） | 关键服务模块 |
|---|---|---|
| 认证/账号 | `/api/auth`（公开 + authMiddleware） | `prisma.user`；email/password + bcrypt + JWT(7d)；邀请/找回密码 |
| 对话（SSE） | `/api/chat`（authMiddleware，发消息叠 30/min 内存限流） | 见 §4 链 A |
| Agent 工具执行 | `/api/actions` | `connections/actions.ts`：createAction/approve/reject，R0 直执行、R2+ pending 用户审批，预览经 secretRedactor 脱敏 |
| 凭据连接 | `/api/connections` | `connections/*`（见 §5） |
| 模型目录 | `/api/models`（authMiddleware） | `configSync.getDynamicModels` + `rateGate.modelLoadStatus`（ok/hot/busy/blocked） |
| 积分 | `/api/tokens` | `credits.ts` 批次（getActiveBatches/临期/addCredits） |
| 记忆 | `/api/memory` | `memory.ts` CRUD + 长期记忆 + 文件记忆 |
| 知识库 | `/api/knowledge`（读 auth / 写 admin） | folders/entries/skills/rules + 研究/组织 job 触发 |
| 支付 | `/api/payment`（auth；审核端 adminAuth） | 订单/凭证上传（`paymentRuntime.processProofPayment`）/QR（alipay/paypal/shopeepay/tng 四 adapter） |
| 动态定价 | `/api/pricing` | `finance/pricingEngine` + `marginEngine`/`costEngine`/`fxVersion`（汇率每日刷新） |
| 语音 | `/api/chat/audio` | `audio/runtime` TTS（gemini/xiaomi）+ intent |
| 媒体 | `/api/chat/media` | 图片/视频生成确认 + Agnes image/video 模型 |
| Office | `/api/chat/office` | `office/*` 文档/表格/演示渲染 + 预览 |
| 设置 | `/api/settings` | 用户设置/模型池/模式偏好/玻璃主题/用量 |
| 语气学习 | `/api/expression` | `expressionLearning` + 区域习惯（regionExpression） |
| 提示词工程 | `/api/prompt`（用户 compose；admin 管原子/场景/扩展/模型能力） | `promptRuntime`/`promptRegistry`/`promptComposer` |
| 供应商目录 | `/api/providers`（公开只读） | `connections/providers` LEGACY 工具目录 |
| 设备/任务/浏览器会话 | `/api/devices` `/api/tasks` `/api/browser` | 设备配对/任务交接/浏览器会话 pause·resume·takeover·awaiting-user |
| 用户技能 | `/api/skills`（authMiddleware） | `userSkillInstall`（SSRF+注入扫描）；admin 端 roster/提升/拒绝在 `/api/admin/skills*` |
| 进化治理 | `/api/evolution`（全 adminAuth） | `modelEvolution` M 系列候选/信号/预算/审计 |
| 可观测 | `/api/admin/observability`（路由级 adminAuth） | traces/errors/billing 聚合（trace/errorEvent/modelCall 表） |
| 管理台 | `/api/admin`（全 adminAuth） | provider 连接 CRUD、模型拉列表、token 用量、仪表板、用户/会话、支付审批、QR、邀请、积分/套餐/价格 |
| 导入 | `/api/admin/import`（adminAuth） | zip/markdown 导入正式 Skill |
| 用户画像 | `/api/user/profile` | 自适应画像/偏好/需求/领域/语言/习惯 |
| 反馈 | `/api/feedback` | 用户提交 + admin 处理 |

## 4. 核心调用链（已核实到函数级）

### 链 A：POST /api/chat 流式对话（`chat.ts:524` 起）
```
意图门（Agnes 2.5-flash，确定性三选一）：媒体生成 / 音频生成 / Office 生成 → 命中返回确认卡
mode=think/research → 每日限额检查 → deepResearch(research.ts) 非流式返回
常规路径 buildAgentChat(chat.ts:145)：
  classifyTask(taskClassifier) → createSession(sessionState)
  → routeModel(router.ts:320)          # 见链 B
  → 温度计算+钳制(modelCapabilityRegistry)
  → RAG 检索(getRelevantChunks) + 记忆注入(getMemories/memoryRuntime.beforeResponse/contextMemory.retrieve)
  → 上下文意图抽取(规则层，不加 AI 调用)
  → 场景运行时 runPromptRuntime(promptRuntime:69)   # 见链 C
  → 用户技能块 renderUserSkillsBlock + 压缩 compactInstalledSkillsBlock(context/compress)
  → compilePrompt(compiler) 拼 finalSystemPrompt
  → rateGate.awaitAcquireRateGate（需排队的模型预排队）
POST 主体：
  createTrace → chatQueue.acquireSlot（全局6/单用户1/队列100）→ SSE queue 事件
  → for await chunk of chatWithFallback(models.ts:8)   # 见链 B/D
  → 流式结束 decision.release()（释放 FREE 轮询预占）
  → verifyResponse + recordRoutingResult
  → addModelCall + 扣积分 + token 计量 → 消息落库(conversation 库)
  → memoryRuntime.afterResponse + M5 归因入队(后台)
```

### 链 B：模型选择 + 轮询 + 三级限速（重构后现状）
- **Pro**：用户手选模型 → `user_selected`，走 Pro key 池；越层/不可用退回 FREE 轮询兜底；
- **免费版**：`freeModelsByProvider()`（tier=FREE+enabled+online 的 LLM，排除 image/video/audio）→ 跨「供应商×API×模型」**纯轮询**（`freeProviderCursor`，不看意图不评分）→ 逐个 `acquireRateGate`；某 key/供应商达限自动切下一个；全被限 → `getDefaultModel`（qualityProfile+contextWindow 最高兜底）；
- **三级速率闸门**（`rateLimiter.ts` 滑窗 + `rateGate.ts` 聚合）：
  1. 单 API（`ProviderConnection.apiLimit`，每 key 独立额度）
  2. 运营商（`carrierLimit`，该供应商全部 key 统一额度）
  3. 调用模型（`ModelConfig.rateLimit`，admin 即时写入 `rateGate.modelRateLimits` 内存注册表）
  每项支持 RPM/TPM/RPD/TPD/最大并行；TPD 到达后可选「不可用」或「限制 RPM」；
- **负载状态**：`rateLimiter.statusOf` → `rateGate.modelLoadStatus` → `GET /api/models` 每模型/厂商带 `load`（ok/hot/busy/blocked），前端 ModelSelector 在积分旁显示「调用量高/需排队/暂不可用」；已选模型被限 → `awaitAcquireRateGate` 自动排队，SSE 发 `model_queued`/`model_throttled`，前端提示条；
- **执行**：`models.chatWithFallback` 逐候选 `callProvider`（streamAgnes/streamGemini/streamOpenAICompatible），429/5xx → `reportKeyFailure` 换下一把 key；全败且无 key → `buildOfflineReply` 离线模拟兜底。
- **注意**：限速状态为**进程内内存态**，重启清零（key 池从 DB 重建，模型限额需 admin 重设）。

### 链 C：场景/Prompt 运行时（P/S/E 机制）
```
runScenarioRuntime(scenarioRuntime.ts:54)：
 P1 场景理解(agnes) → P2 检索+决议(reuse/inherit/create/child/merge/split → prismaKnowledge.scenario)
 → P3 原子选择 ∥ S2 技能判官 → P4 生成 prompt(仅新场景) → p3HardGate/explore → S4 技能终选(纯代码，权威)
 → persistSelectionDecision(prismaKnowledge.selectionDecision)
模型自动选择子系统已删除：场景不再覆盖模型选择（router.routeModel 为唯一入口）。
M 系列进化（m1画像/m2新场景/m3新模型/m4漂移/m5结果/m6归因）跑 worker 池，候选经 /api/evolution admin 治理。
```

### 链 D：连接（Connections）与凭据
```
POST /api/connections/web/connect      → browserConnector.authenticate（Playwright 无头 Chromium，
                                          自动登录 + 验证码/MFA 委托用户 + 会话持久化 BrowserSession）
POST /api/connections/web-token/connect → tokenConnector（六类：bearer/oauth_access/api_key/basic/cookie/custom）
POST /api/connections/:provider/connect → 仅 github 可连：api(PAT verifyToken) 或 oauth(code 交换)
                                          checkRepoPermissions 决定权限集 → storeCredential(vault)
执行：POST /api/actions → createAction → checkPermission(permissionEngine)
       → allow(R0 直执行) | deny | pending(R2+ 写 prisma.actionRequest 等用户审批)
       → executeAction：GITHUB_TOOLS 或 selectConnector 路由到连接器
凭据：vault.ts AES-256-GCM（VAULT_KEY），按 user+provider+type 隔离，密钥不出模块/不落日志，
      外发前 secretRedactor 脱敏，执行后 read-back 验证
```

### 链 E：用户技能（Skill）安装
```
POST /api/skills/install {url, token?} → userSkillInstall.installUserSkillFromUrl
  GitHub 项目/raw .md/zip → frontmatter/manifest 解析 → checkInjection+执行特征扫描
  → clean 即 active / flagged 落 pending → 落 UserInstalledSkill（@@unique[userId,sourceUrl]）
SSRF 防护：仅 https，GitHub host 白名单，其它 host dns.lookup 拒绝内网/回环
使用：chat.ts 在 compilePrompt 前 best-effort renderUserSkillsBlock(userId)
  把该账号 active+clean 技能拼 [Your Account Skills] 注入系统提示词（compiler/promptRuntime 双路不重复）
治理：GET /api/skills/available（全局池）；admin roster（跨账号全量）
  POST /api/admin/skills/roster/:id/promote → 唯一提升路径：upsert prismaKnowledge.skill
  + skillPublishGuard(admin_import) + S1 分析 job（AI 永不直接发布正式技能）
```

### 链 F：搜索
`searchLayer.webSearch(query, {engine})`：auto 顺序 = Perplexity（配了 `PERPLEXITY_API_KEY` 时，默认 `sonar` 基础搜索，合成答案放首条 `answer`）→ Google CSE → Tavily → DuckDuckGo（无限兜底）。`researchExecutor` 按研究计划 `plan.searchEngine` 选用。

## 5. 子系统 AI 调用边界（已按约定落位）

**只允许 Agnes 2.5/3.0-flash，统一走 `scenarioWorkers/agnesCaller.callAgnes`（模型名强制 toLowerCase）**：
- P1 场景理解 / P4 生成 prompt / P5 自由文本结果 / S1 技能语义抽取 / S2/S3 技能×场景拟合、因果 / knowledgeOrg 语义去重 / contextAnalyzer（local 优先，仅泛化消息升级 2.5-flash）/ 媒体意图 / paymentReview OCR（3.0-flash 视觉，TNG 截图已实测通过）

**已完全代码化（不再调 AI）**：S4 技能终选（`s4SkillSelection`）、M4 漂移（`deterministicM4`）、M5/M6 归因、E1 归因（`deterministicE1`）、进化信号映射（`evolution.ts`，gate2/gate3 保留 LLM 质量/安全判定）。

**保留多供应商（用户面能力，不动）**：用户选模流式（models.ts）、TTS（gemini/xiaomi）、图片/视频生成（agnes-image/video）、外部搜索（Perplexity sonar）。

**坑（已修，勿回退）**：Agnes 网关模型 id 是小写 `agnes-3.0-flash`；大写 → 503 `model_not_found`。

## 6. 支付与计费

- 四家 adapter：`paymentAdapterAlipay/Paypal/ShopeePay/Tng`；凭证上传 → `paymentRuntime.processProofPayment` → `paymentReview` 用 Agnes 3.0-flash 多模态 OCR 自动初审（收款金额/收款人/状态/交易号/遮挡检测），异常转人工（admin `/api/payment/admin/payments/:id/approve|reject`）；
- 定价：`finance/pricingEngine` 动态版本（bootstrap + 每日 margin 任务 + 汇率 fxVersion），成本 `providerCosts`/`costEngine`，积分公式 `billing/creditFormula`，token 计量 `billing/tokenUsage`，账本 `creditLedger`/`billingLedger`；
- 每日订单清理（`orderCleanup`）+ 日志清理（`logger.runCleanupCycle` 6h）。

## 7. 记忆与知识

- 记忆：短期 `memoryRuntime`（before/afterResponse 钩子注入对话）；长期 `longTermMemory`；文件记忆 `fileMemory`；上下文记忆 `contextMemory/`（压缩/抽取/验证/worker，contextCompressionJob）；
- 知识：双层知识库（`knowledgeRuntime` + `knowledgeRetrieval` RAG/vectorSearch）；`knowledgeOrg/` 组织（扫描/快照/校验/应用/worker）；`knowledgeLifecycle/` 自愈（刷新调度 + 事实时间戳/值差 + 精度门 + 修复摄入）；
- 数据分布：user 库（user/连接/skill 安装/S1 job）、conversation 库（会话/消息）、knowledge 库（场景/原子/进化候选/决策/正式 skill/知识/研究 job）、overflow 库（trace/大字段，主写失败自动溢出路由）。

## 8. 前端结构（client/src）

- **页面** `app/`：`onboarding`（注册/登录，auth 阶段）、`login/register/forgot-password`、`chat`（主界面）、`payment/pricing/subscription`、`settings`（含 connections 连接管理）、`admin`（含新 `admin/models`：免费/Pro 面板 + 三类限额编辑器；`admin/skills`：全局目录 + roster 提升）、`skills`（新，用户技能安装/列表）、`tools`、`auth/callback/[provider]`（空目录，SSO 交接页位置）、`privacy/terms/not-found`；
- **模型选择** `components/ModelSelector.tsx` + `store/modelCatalog.ts`（新，数据源 = `GET /api/models` 的 groups，静态回退已清空）：免费版仅「思考等级」三档（快速/标准/思考），Pro 按厂商分组（去前缀显示名 + 积分消耗 + 负载状态）；`discoveredModels.ts` 已删；
- **聊天** `components/ChatWindow.tsx` + `store/chatStore.ts`：SSE 流式、队列状态提示条（model_queued）、重试/复制/编辑、媒体确认卡；
- **连接门控** `layout.tsx` 轮询 `/api/health`，不通过只显示「连接失败，请稍后重试」；
- **数据访问** `lib/api.ts` + `lib/db.ts`：已全部走后端 API（Supabase 直连已移除，commit `e86da99`）；`vercel.json` 将 `/api` 代理到 Render 后端；
- 设计规范：`globals.css`/`tailwind.config` 设计令牌（柔和投影/深色柔光、统一圆角间距、150–300ms 克制动效），已移除液态玻璃。

## 9. 运维流程（硬性约定）

1. 部署前**先唤醒 4 个 Layerbase 数据库**（pooler 休眠，首连 10–30s 卡住属正常，勿误判为失败；CLI 首连 P1001 需重试）；
2. 提交**只提 main 分支**；
3. Render **手动触发**部署；Vercel 自动；
4. AI 调用节奏：合并调用，**≤7 次/分钟**；
5. 子系统只用 Agnes 2.5/3.0-flash。

## 10. 未提交改动清单（git status，= 最近一轮开发成果）

**后端新增**：`routes/userSkills.ts`、`services/{userSkillInstall,skillRoster,skillPromotion,providerConfig,rateGate,rateLimiter,regionExpression}.ts`、`services/context/`（compress）、`connections/connectors/token.ts`、`scripts/`（冒烟/管理端点脚本）。
**后端修改**：`config.ts`（模型注册表清空）、`router.ts`/`models.ts`/`apiKeyPool.ts`/`configSync.ts`（模型重构）、chat.ts（队列/排队事件）、expressions/knowledge/memory 全家（Agnes 化）、paymentReview（小写模型名）、`schema.prisma` + `schema-user.prisma`（`migrations-user-model-reorg.sql`：provider_connection 加 tier/api_limit/carrier_limit+复合主键；model_config 加 vendor/rate_limit；UserInstalledSkill 表）。
**前端新增**：`admin/models/`、`skills/`、`store/modelCatalog.ts`、`lib/fonts.ts`、`vercel.json`；**删除**：`store/discoveredModels.ts`、`services/modelDiscovery.ts`。
**其它**：`headroom-py/`（纯 Python 压缩 MCP，独立于主程序）、`ai_snapshot.txt`、`dense_file.*`、`compressed_error.log`（临时产物）。

## 11. 已知问题与风险（本次核实）

1. **SSO（Google/GitHub 登录）代码缺失**：`routes/auth.ts` grep 零命中 oauth；onboarding 无 SSO 按钮；`app/auth/callback/[provider]/` 是空目录。项目记忆存有完整设计蓝图（§12）。
2. `services/router.ts` 残留大段死代码（旧「Auto Model Router 2.0」评分引擎，仅 `filterByTier` 仍被引用）；`modelRouter/scenarioRouter.ts` 亦疑似残留（自动选模已删）。
3. `chat.ts` 新旧两套 SSE 处理器并存（`/conversations/:id/messages` 与 `/:id/messages`），逻辑漂移风险。
4. 限速为进程内内存态，重启清零；多实例部署会各自为政（当前单实例 Render，暂 OK）。
5. `contextAnalyzer.ts` 函数名 `callGeminiAnalysis` 实际已调 Agnes（命名遗留，易误导）。
6. README 严重过时（仍写 Supabase/Railway/「智能路由自动选择最优模型」，实际 Layerbase/Render/手动选模）。
7. `routes/providers.ts` 两个端点公开只读（设计如此，注意不泄敏感字段）。
8. 沙箱 `.env` 无 Agnes key、DB 无 agnes 供应商连接 → 子系统 AI 走无 key 兜底；实测需临时给 key 或 admin 建连接。

## 12. 待开发任务（按优先级）

1. **SSO 重建（蓝图在记忆中，照做即可）**：
   - 后端 `routes/auth.ts` 末尾加 4 端点（无 DB schema 改动，find-or-create 按 provider 邮箱；新用户 passwordHash=随机 hex）：
     `GET /auth/oauth/available` → `{google, github}`（是否配了 client id）；
     `POST /auth/oauth/:provider/start` → 授权页 URL（HMAC state 防 CSRF；未配 501 优雅降级）；
     `POST /auth/oauth/callback` `{provider, code, state}` → 换 token → find-or-create → 7d JWT；
     `POST /auth/github/token`（PAT 兜底，无邮箱用 `{login}@users.noreply.github.com`）；
   - 前端：onboarding auth 阶段加「Google 登录 / GitHub 登录」按钮 + GitHub PAT 折叠框；`app/auth/callback/[provider]/page.tsx` 交接页（读 ?code&state → POST callback → saveAuth → created?/onboarding:/chat）；
   - env：`GOOGLE_CLIENT_ID/SECRET`、`GITHUB_CLIENT_ID/SECRET`（可选 redirect URI，默认 `{CLIENT_URL}/auth/callback/{provider}`），需在 OAuth 应用注册 redirect。
2. 清理死代码（router.ts 旧评分引擎、modelRouter 残留、chat.ts 旧别名评估）。
3. 更新 README（技术栈 + 部署 + 功能对齐现状）。
4. `contextGate` 类小项：chatQueue 常量可配置化（可选）。

## 13. 凭据与安全现状

- 对话历史中曾明文出现：Layerbase 4 库密码、Perplexity API key、Agnes 测试 key、Vercel/Render token、测试账号——**建议轮换**（至少确认 Agnes 测试 key 已失效）；
- 生产：`JWT_SECRET`/`VAULT_KEY` 缺失即启动失败（P0 防护已加）；
- 用户凭据（浏览器/token 连接）AES-256-GCM 加密入 vault，只回传结构化结果不含 token；
- skill 安装全链路 SSRF + 注入扫描；正式技能 AI 不可发布（guard + admin 提升唯一路径）。
