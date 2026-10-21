# 成本归集 / 账本 / 积分扣减 / 价格研究 — 只读事实记录

> 范围：`server/src/services/finance/*`、`server/src/services/credits.ts`、`server/src/services/billing/*`、
> `server/src/services/priceResearch.ts`、`server/src/services/paymentAdapter*`、`server/src/routes/payment.ts|chat.ts|admin.ts`
> 及 `server/prisma/schema-user.prisma`。所有行号均为只读勘察结果，未修改任何源码。

---

## 模块级事实（含关键行号）

| 模块 | 事实 | 证据 |
|---|---|---|
| finance/billingLedger.ts | 自称"唯一能改余额的路径"，单表 `CreditLedger`，append-only，重复 idempotencyKey 拒绝二次入账 | billingLedger.ts:1-9、:61-70 |
| finance/billingLedger.ts | 操作类型：`grant/reserve/charge/refund/reversal`，同时镜像写 `creditTransaction`（legacy） | billingLedger.ts:15、:107-116、:151-169 |
| finance/providerCosts.ts | Provider USD 成本参数表（`ProviderPricingVersion`）+ 公式函数 `computeCostFromPricing` | providerCosts.ts:1-11、:92-107 |
| finance/money.ts | 业务常量：保护系数 1.15、固定成本汇率 4.50、目标毛利率 0.30 | money.ts:15-20、:64-70 |
| finance/pricingEngine.ts | 每日定价任务：抓 FX → 算毛利 → ±5% → 钳制 → 发布新 PricingVersion | pricingEngine.ts:337-401、:165-220 |
| finance/fxVersion.ts | 每日 USD/MYR 市场汇率快照（open.er-api.com），失败则保留旧版并阻断发布 | fxVersion.ts:24-37、:76-81 |
| credits.ts | 薄封装：扣积分/退款/发放/日限额，全部转调 finance/billingLedger | credits.ts:1-3、:5-45、:47-83、:85-105 |
| billing/tokenBilling.ts | token→积分的**唯一换算点**（现已废弃模式乘数/overflow/防反推取整） | tokenBilling.ts:1-31、:64-79、:85-91 |
| billing/tokenUsage.ts | chat 路径入口：provider usage → 真实 token → 扣费 + TokenUsage 落库（单事务 + 3 次重试） | tokenUsage.ts:1-9、:91-134、:136-185 |
| creditLedger.ts | **第二套**账本实现（grant/reverse/computeBalance/verifyBalanceConsistency），与 billingLedger 并存 | creditLedger.ts:1-9、:32-89、:93-142、:156-182 |
| priceResearch.ts | 商品实时比价（ephemeral，只进内存缓存，永不落库），与本站售价无关 | priceResearch.ts:1-6、:44-47、:152-213 |
| paymentReview.ts | 付款截图 OCR/视觉抽取层，"AI 只抽取、不做财务决策" | paymentReview.ts:1-9、:97-132、:152-211 |
| paymentVerification.ts | 确定性规则校验（金额/币种/收款人/幂等/订单状态/时间） | paymentVerification.ts:1-6、:33-182 |

---

## provider 成本归集链路

### 1. 设计中的链路（ProviderPricingVersion）

`providerCosts.ts` 定义了完整公式，但**生产链路上无人调用**：

| 步骤 | 位置 | 内容 |
|---|---|---|
| 读表 | providerCosts.ts:23-32 | `getActiveProviderPricingVersion(provider)` → `prisma.providerPricingVersion.findFirst`，条件 `provider` 匹配 + `effectiveAt <= now` + (`expiresAt is null` 或 `>= now`)，按 `effectiveAt` 倒序取 1 条 |
| 写表 | providerCosts.ts:34-58 | `createProviderPricingVersion` → `prisma.providerPricingVersion.create`，字段 `inputCostPerMUsd / outputCostPerMUsd / cachedCostPerMUsd`，`protectionFactor` 默认取 `COST_PROTECTION_FACTOR`=1.15，`costFxRate` 默认取 `COST_FX_RATE`=4.50 |
| 播种 | providerCosts.ts:73-88 | `seedProviderPricingFromEnv` 读 `PROVIDER_COST_TABLE_JSON`（:60-71 解析），仅在无 active 版本时创建；调用点 `index.ts:254`（启动后 10s） |
| **公式** | providerCosts.ts:92-107 | `computeCostFromPricing(pricing, inputTokens, outputTokens, cachedTokens=0)`：`perM = 1_000_000`；`input = inputCostPerMUsd × inputTokens / 1e6`（:100）；`output = outputCostPerMUsd × outputTokens / 1e6`（:101）；`cached` 仅在 `cachedCostPerMUsd` 非空且 `cachedTokens > 0` 时计入（:103-105）。**pricing 为 null 时返回 null，绝不 fallback 0**（:98） |
| 成本保护 | money.ts:64-70 | `protectedCostUsd = actualCostUsd × 1.15`；`protectedCostMyr = protectedCostUsd × 4.50` |

**关键结论：`computeCostFromPricing` 全仓库无任何调用方（仅定义处 providerCosts.ts:92 自身命中）。**
`getActiveProviderPricingVersion` 仅被同文件 :79 的 seed 逻辑调用。即 `ProviderPricingVersion` 表会因 env 播种产生数据，但**从不参与任何一次模型调用的成本计算**。

### 2. 实际生效的链路（costPer1k → credits）

真实计费走的是"积分单价"而非 Provider USD 价：

| 步骤 | 位置 | 内容 |
|---|---|---|
| 单价来源 | schema-user.prisma:1549 | `ModelConfig.costPer1k` — 注释明确"积分/1000 token；0=免费；Pro 手动输入" |
| 单价加载 | configSync.ts:64-84、:101 | `loadModelConfigs()` 从 `ModelConfig` 读入 `costPer1k`，与 `MODEL_REGISTRY`（config.ts:65）合并 |
| 兜底 | config.ts:227-632 | 硬编码 `costPer1k`（0=免费档；0.233 / 0.728 / 1.0 / 10.0 / 16.667 / 41.667 等） |
| token→credits | tokenBilling.ts:85-91 | `deductCredits(result, modelKey)` = `Math.ceil((displayTotal / 1000) × costPer1k)`，`costPer1k <= 0` 返回 0 |
| chat 取值 | chat.ts:963-964、:1635-1636 | `usedModelInfo = getDynamicModels()[usedModel] \|\| agent.modelInfo`（按实际产出模型计费，含 fallback 切模型） |
| chat 计算 | chat.ts:970、:1637 | `apiCost = tokenCount × costPer1k / 1000`（**creditsCost 同式，chat.ts:985、:1650**） |

### 3. 被误标为 USD 的字段

`chat.ts:978-980` 与 `:1645-1647` 把 `inputCostUsd / outputCostUsd / totalCostUsd` 写成
`token × costPer1k / 1000` —— 而 `costPer1k` 的量纲是**积分/千 token，不是美元**。
这三个字段最终写入 `ModelCall.totalApiCostUsd`（trace.ts:100 附近），因此 `ModelCall.totalApiCostUsd`
实际存的是积分值。另：`providerUsage` 缺失时 `inputTokens * costPer1k / 1000` 为 `NaN`（chat.ts:968-969）。

---

## 账本写入点汇总（表格式：事件 / 文件:行 / 写入字段）

所有账本写入最终都汇到 `finance/billingLedger.ts:61-147 applyEntry()`（`prisma.$transaction`，:66）：

| 事件 | 文件:行 | 写入字段（表） |
|---|---|---|
| AI 调用扣费（chat 主路径） | credits.ts:19-28 → billingLedger.ts:80-133 | `creditLedger`: userId, model, type=`deduction`, amount(负), balanceAfter, status=`settled`, description, idempotencyKey, traceId, requestId, creditsUsed；`creditTransaction`(镜像)；`user.creditBalance` |
| 购买发放-积分包 | paymentRuntime.ts:423-433 | `creditLedger` type=`purchase`, paymentId, orderId, amount, pricingVersionId, metadata{orderPlan,paidAmount}, idempotencyKey=`credit_grant_${paymentId}`；`creditBatch`{validDays=PERMANENT_PACK_VALID_DAYS, source=purchase}；`user.creditBalance` |
| 购买发放-遗留 Ultra | paymentRuntime.ts:436-446 | 同上，batch validDays=30, source=subscription |
| 购买发放-Pro 月/年付（1 或 12 批） | paymentRuntime.ts:454-467 | 每批独立 `creditLedger` 行 + `creditBatch`（validDays=30）；idempotencyKey 首=`credit_grant_${paymentId}`，其余 `..._batch_${i}` |
| 管理员审批发放 | admin.ts:465-473、:484-493 | 同 grantCredits；idempotencyKey `admin_approve_${orderId}`（+`_batch_${i}`）；前置条件状态机 updateMany admin.ts:452-456 |
| 管理员直接加钱 | admin.ts:~470 区间接 grantCredits | `creditLedger` type=`purchase` |
| tokens 路由加钱 | tokens.ts:67 → credits.ts:85-94 | `creditLedger` type=`purchase`，idempotencyKey 含 `Date.now()`+随机串 |
| 退款 / 冲正 | credits.ts:47-83 → billingLedger.ts:163-169 | `creditLedger` type=`refund` / `reversal`；**`refundCredits` 在 credits.ts:47 定义但全仓无调用方** |
| 预留 reserve | billingLedger.ts:155-157 | `creditLedger` type=`reserve`, status=`reserved`；**`reserveCredits` 全仓无调用方** |
| 第二套账本-发放 | creditLedger.ts:56-85 | `creditLedger` type=`purchase`（不含 batch/pricingVersion/trace 维度）；`creditTransaction`；`user.creditBalance` |
| 第二套账本-冲正 | creditLedger.ts:113-138 | `creditLedger` type=`reversal`，`balanceAfter = Math.max(0, before - credits)`（**静默截断为 0，不报错**） |
| 明细交易（trace 侧） | trace.ts:172-197 → :192 | `billingTransaction` create（tokens 维度：amount/balanceBefore/balanceAfter/reason/model/pricingVersion/idempotencyKey） |
| TokenUsage 落库（与扣费同事务） | tokenUsage.ts:105、:112 | `tokenUsage` create（usageData 由 buildUsageRecord tokenUsage.ts:48-84 组装） |

`applyEntry` 内的写入顺序：幂等检查（:67-70）→ 用户检查（:72-73）→ 符号与余额（:75-78）→ `creditLedger.create`（:80-105）
→ `creditTransaction.create`（:107-116）→ `creditBatch.create`（:118-131，仅 `batch` 非空且非负向）→ `user.update`（:133）。
并发重复走 `P2002` 唯一键兜底（:137-146）。

---

## 积分扣减链路与失败行为

chat 路径一次模型调用会触发**两条彼此独立的扣减路径**：

**路径 A（legacy 扣费）**：`chat.ts:989 / :1654` → `credits.ts:5-45 deductCredits` → `billingLedger chargeCredits`(:159)
→ `applyEntry`(:61) → `creditLedger.create` + `creditTransaction.create` + `user.update(creditBalance=balanceAfter)`（**绝对值覆写**）。

**路径 B（token billing runtime）**：`chat.ts:1003 / :1663` → `tokenUsage.ts:136 processTokenUsage` → :172
`creditsUsed = deductCredits(display, modelKey)` → :173 `withRetry(() => deductUserCredits(...), 3)` → `tokenUsage.ts:99-113`：
单 `$transaction` 内 `tx.user.update({ creditBalance: { decrement: credits } })`（:108-111，原子自减）
+ `tx.tokenUsage.create`（:112）。

chat.ts:999-1001 的注释称路径 B "只落 split 记录"，但 `deductUserCredits` 实际**再次自减余额** →
同一请求被扣两次（A 用绝对覆写、B 用原子自减，互不可见）。日志侧 `creditsBefore` 取自内存里的
`user.creditBalance`（chat.ts:990），与 B 的真实扣减不一致。

**事务边界**
- A：余额写与账本写在同一个 `prisma.$transaction`（billingLedger.ts:66-136）内；与 TokenUsage 落库**不同事务**。
- B：扣减与 TokenUsage 在同一事务（tokenUsage.ts:99-113）。
- A 与 B 之间**没有任何共享事务或锁**，仅各自依赖 `idempotencyKey`（A: `bill_${requestId}` 或 `deduct_${userId}_${traceId||Date.now()}`，credits.ts:22）与 TokenUsage 无幂等键。

**失败行为**
- 余额不足（A）：`credits.ts:13-15` 先 `findUnique` 预检，`user.creditBalance < amount` 直接抛 `积分不足`；
  chat.ts:991-993 捕获后只写 error 事件，**响应照常返回，用户拿到内容但不扣费**。
- 余额不足（applyEntry 内）：billingLedger.ts:77-78 `balanceAfter < -0.000001` 抛 `积分不足`，整个事务回滚（账本不落行）。
- 余额不足（B）：tokenUsage.ts:102-107 仍写 `tokenUsage`，但**跳过扣减**（不写穿 0）。
- 死锁/串行化冲突（B）：tokenUsage.ts:115-131 仅对 `serialization failure|deadlock`/P1017/P1001 退避重试 3 次（200ms×attempt），耗尽抛 `DB_BUSY`。
- 幂等重复（A）：billingLedger.ts:67-70 命中已存在 key 返回 `duplicate:true` 与旧 `balanceAfter`，不重复入账；竞态重复由 `P2002` 兜底（:139-143）。
- Trace 明细：credits.ts:30-42 仅在 `traceId && !result.duplicate` 时补写 `billingTransaction`。

**并发处理（缺陷点）**：A 的预检是 read-then-act（credits.ts:13→19），`applyEntry` 也是"读 `user.creditBalance`
再写绝对 `balanceAfter`"（billingLedger.ts:72-77、:133）。两个并发请求都读到同一旧余额时，后写者
覆盖前写者 → **余额丢失更新**。唯一约束幂等键只在 key 相同（同 requestId）时生效，不同 requestId 的并发
无保护。只有 B 用 `{ decrement }` 是竞态安全的。

---

## priceResearch 的真实作用与调用方

**结论：它是"商品实时比价"模块，与 OmniTaskAI 自身售价无任何关系，且 `researchPrice` 全仓无调用方。**

**它做什么**
- 输入是一个 `objectId`（KnowledgeObject id），先查 `prismaKnowledge.knowledgeObject.canonicalName`（:100-104），
  再构造 `<name> <configuration> price official site <region>` 等 3 条查询（:106-113），调 `webSearch`（:119）。
- 用正则从 title+snippet 里抽价格：货币符号/代码 + 金额，限定 1 ~ 1,000,000（:77-91）。
- 产出 `PriceResult { prices[], lowest, highest, currency, variant, configuration, retrievedAt, sourceCount }`（:195-206）。
- 结果只进进程内存 `Map` 缓存：TTL 15 分钟（:44）、上限 500 条（:46，过半则淘汰最旧 :67-75）、
  硬超时 15s（:45，`Promise.race` :173-174）、单查询最多 8 条结果（:47）。
- 超时且有缓存则返回旧缓存，无缓存返回带 `error` 的空结果（:176-189）。
- 文件头明确"NEVER written to the Knowledge DB"（:2-5），缓存 key 串上 region/platform/configuration/currency
  以防止跨区串味（:56-65）。

**与本站售价的关系：无。**
- `researchPrice`（:152）全仓无调用方（唯一命中是定义自身）。
- `researchPlanner.ts:214` 只在 `ResearchPlan` 上置 `priceResearch: device` 布尔标记（:12 字段定义），
  该标记在 `researchManager.ts` / `sourceRouter.ts` 中**从未被读取**（两文件只 import 了 `ResearchPlan` 类型）。
- 本站售价链路完全独立：`PricingVersion`（schema-user.prisma:1356-1370）由 `pricingEngine.runDailyPricingJob`
  （:337）按 FX + 套餐价 × 1.15 × 4.50 的毛利驱动（:359-368），发布节奏 max 1 次/天（:222-226、:339）。
- 唯一的"价格研究"持久化痕迹：`DiscoveredModel` / `ModelPriceHistory` 两个表（schema-user.prisma:1913-1949）
  **全仓无任何写入方**，且没有任何代码 import priceResearch 的产物去写它们。

**若问"谁调用它、多久一次、结果写到哪里"：无调用方、无定时任务、结果不落库（仅内存缓存）。**

---

## 支付渠道货币与汇率应用点

**下单金额的货币**：以 `user.currency`（缺省 `USD`）为准的下单当地货币（payment.ts:23、:67、:70）。

| 步骤 | 位置 | 内容 |
|---|---|---|
| 权威价（USD） | payment.ts:26-40 | 静态配置取价：`pack.price` / `getDynamicPricing().PRO.monthly|yearly`（注意此处为 USD） |
| 版本锁（USD） | payment.ts:50-59 | `lockPackPricing/lockSubscriptionPricing` → `orderLock.priceUsd`；命中后**覆盖**静态价（:57），再换算（:58） |
| **USD→当地货币** | **payment.ts:43** | `if (currency !== 'USD') localAmount = await convertFromUSD(expectedAmount, currency)` |
| **USD→当地货币（版本锁路径）** | **payment.ts:58** | `localAmount = currency === 'USD' ? expectedAmount : await convertFromUSD(expectedAmount, currency)` |
| 落库 | payment.ts:64-79 | `paymentOrder.expectedAmount = localAmount`、`remainingAmount = localAmount`、`currency = user.currency`、`lockedPriceUsd = orderLock.priceUsd`（保持 USD）、四个版本 ID |
| 初始 Payment | payment.ts:82-92 | `Payment.amount = localAmount`、`currency`、status `PENDING`、`sourceType: 'order_created'` |
| 换算实现 | exchangeRate.ts:110-116 | `convertFromUSD = usdAmount × rate`，按目标币小数位取整（0 位四舍五入，2 位 toFixed） |
| 汇率来源 | exchangeRate.ts:100-108 | `getRate(target)` → `prisma.exchangeRate.findUnique({base:'USD', target})`，**查不到回落 1**（:106），异常也回落 1（:107） |
| 汇率刷新 | exchangeRate.ts:70-98、:130-136 | `fetchAndStoreRates()` 从 `https://open.er-api.com/v6/latest/USD` 拉取并 upsert；启动 +5s 一次，之后每 24h |
| 渠道默认币 | paymentAdapterAlipay.ts:38、:63 | Alipay 默认 `CNY` |
| 渠道默认币 | paymentAdapterPaypal.ts:31、:55 | PayPal 默认 `USD` |
| 渠道默认币 | paymentAdapterTng.ts / paymentAdapterShopeePay.ts | 默认 `MYR` |

**要点**
- 适配器只做**入站归一化**（`normalize(raw)`）：金额 `parseFloat(...)||0`、币种取 raw 或回落默认币，
  不含任何 USD↔当地币换算逻辑；**汇率只在 payment.ts:43/:58 + exchangeRate.ts:110-116 被应用一次**。
- 出站时用户看到/被要求支付的就是 `paymentOrder.expectedAmount`（当地货币），`lockedPriceUsd` 单独留存 USD 审计值。
- 校验端同样按当地币比较：paymentVerification.ts:94-111 `expectedRemaining = order.remainingAmount \|\| order.expectedAmount`；
  :114-122 要求 `input.currency === order.currency`（不一致直接判失败，属 critical）。
- **成本侧与收入侧用两套不同汇率**：成本按固定 4.50（money.ts:16），收入按市场汇率（money.ts:73-75、pricingEngine.ts:362）。
- 渠道手续费：`exchangeRate.ts:30-46 getPaymentMethods` 中 PayPal 通道 `feePercent: 4.4`（MYR/CNY 通道为 0），
  但该费用**只影响展示/方法清单，订单金额未加收手续费**。

---

## 数据库相关 model 字段清单 + 死字段标注

> "死字段"= 全仓无写入方（仅 select/条件出现）。
> 由 255 个 `.ts` 文件的 delegate 调用扫描 + 人工核对 create/update data 得到。

### CreditLedger（schema-user.prisma:1012-1045）— 权威账本
| 字段 | 写入方 |
|---|---|
| id / userId / type / amount / balanceAfter / idempotencyKey | billingLedger.ts:80-89；creditLedger.ts:56-66、:113-122 |
| description / metadata / status | 同上（status 由 type 派生：'reserve'→reserved，否则 settled，:91） |
| traceId / requestId | 仅 credits.ts:19-28 传入（deduct/refund 路径） |
| paymentId / orderId | paymentRuntime.ts:423-467、creditLedger.ts:59-60、:116 |
| pricingVersionId | paymentRuntime.ts:430、:443、:463 |
| creditsUsed | credits.ts:27 |
| **code** | **死字段**（无任何写入方） |
| **actualCostUsd** | **死字段**（接口 LedgerInput 有定义 billingLedger.ts:35，但无调用方传值） |
| **protectedCostUsd** | **死字段**（billingLedger.ts:36 定义，无调用方） |
| **protectedCostMyr** | **死字段**（billingLedger.ts:37 定义，无调用方） |
| **provider** | **死字段**（billingLedger.ts:30/94 定义，无调用方传值） |
| **inputTokens / outputTokens / totalTokens** | **死字段**（billingLedger.ts:32-34 定义，无调用方传值） |

### CreditTransaction（:140-150）— legacy 镜像表
userId/amount/balance/type/description 由 billingLedger.ts:107-115 与 creditLedger.ts:77-85、:130-138 写入。
**`model` 字段由 billingLedger.ts:114 写入，但 creditLedger.ts 的第二套实现不写 model。**

### CreditBatch（:152-164）
amount/remaining/source/description/expiryDate/userId 由 billingLedger.ts:121-130 写入；
`isActive` 只在 `getActiveBatches/getExpiringBatches`（credits.ts:108、:114）里做查询条件，**无任何更新方 → 过期批次永不置 false**。

### CreditPack（:166-172）
credits/price/currency/isActive 由 admin.ts:726（upsert）、:740、:754（update）写入；
读取方 configSync.ts:123（`isActive: true`）。

### TokenUsage（:2238-2287）
写入方：tokenUsage.ts:105、:112（data 由 buildUsageRecord :48-84 组装）。
- **注意：schema 中 `multiplier` 被声明了两次（:2247 与 :2264），而 `server/prisma/schema.prisma:2222/:2239` 同样重复，
  但 `migrations-user.sql` 与已生成的 client（`index.d.ts` TokenUsageCreateInput）中只有一个 `multiplier` → schema 与生成物已漂移。**
- schema 注释自称"从未写入的死列"并经扫描确认无写入方：`inputTokens`、`outputTokens`、`totalTokens`
  （与 actual* 重复）、`cacheHitTokens`、`cacheMissTokens`、`costUsd`、`creditsSpent`（:2269-2279）。
- `provider` 为**必填**（:2245；生成的 client 中 `provider: string` 必填），而 `buildUsageRecord` **未设置 provider**
  → 见"开放问题"第 1 条。
- `durationMs`、`status`、`conversationId` 亦无写入方（分别属死字段/未传值）。

### ModelConfig（:1541-1568）
`costPer1k` 由 admin.ts:576/587（upsert）、:675/:686（update）写入；读取方 configSync.ts:84、routes/models.ts、chat.ts:964。
`overrideKeys/lastSyncedAt` 等其余字段只在 admin 展示/同步路径出现。

### SubscriptionPricing（:1570-1578）
monthlyUsd/yearlyUsd/creditGrant/isActive 由 admin.ts:772（upsert）写入；读取方 admin.ts:763、configSync.ts:155。
**注意：定价权威已迁移到 `CreditPricingVersion.packagesJson/subscriptionJson`（pricingEngine.ts:189-198），
本表只在 admin UI 作为可编辑源，不影响已发布的 PricingVersion。**

### PricingVersion / CreditPricingVersion / FxVersion / ProviderPricingVersion
| 表 | 写入方 | 说明 |
|---|---|---|
| PricingVersion | pricingEngine.ts:200-214（transaction 内先 updateMany 把旧 active 置 superseded，再 create） | code `pv-<ts>`；publisher 默认 'auto' |
| CreditPricingVersion | pricingEngine.ts:189-198 | packagesJson / subscriptionJson / modelCreditsPerMJson / minSafe / maxSafe 全为 JSON 字符串 |
| FxVersion | fxVersion.ts:45-57 | 每次 create 前把同 base/quote 的 active 置 false |
| ProviderPricingVersion | providerCosts.ts:45-56 | 仅 env 播种；computeCostFromPricing 无调用方 |

### PaymentOrder（:183-215）
写入方：payment.ts:64-79（create）、payment.ts:136/154/162/178（状态流转）、paymentRuntime.ts:473-480、:486-493、admin.ts:452-455、:508、orderCleanup.ts:7。
- `pricingVersionId/fxVersionId/providerPricingVersionId/creditPricingVersionId/lockedPriceUsd/lockedCredits/creditValidDays`：仅 payment.ts:71-77 create 时写入，之后只读。
- `creditGranted/creditGrantedAt`：仅 paymentRuntime.ts:473-480 写。
- `verifiedTotal/remainingAmount`：paymentRuntime.ts:486-493 累加更新。

### Payment（:866-917）/ PaymentVerification（:957-973）/ PaymentAttribution / PaymentProof / PaymentAuditLog
写入方分别为 paymentRuntime.ts:83-104/143-151/198-204/501-504、paymentVerification.ts:190-202、
paymentRuntime.ts:129-140/309-319/636-648、paymentReview.ts:170-173（`ocrResult/walletType/hasObstruction/fileHash`）、
paymentRuntime.ts:507-513 与 admin.ts:499/509、payment.ts:193/220/424。
**PaymentVerification 只 create 从不 update**（每次校验追加一行，靠 `include: verifications` 取最新）。

### 整表无写入方（死表）
| 表 | 位置 | 说明 |
|---|---|---|
| **ModelUsage** | schema-user.prisma:298-307 | 全仓无任何 write/read 命中 |
| **PaymentTransaction** | :217-234 | 定义齐全但无写入方（订单事务历史实际由 Payment/creditLedger 承担） |
| **PaymentReconciliation** | :975-990 | 无写入方 |
| **Refund** | :1047-1064 | 无写入方（因此"退款"只有 creditLedger 的 type='refund' 概念，没有 Refund 落库） |
| **ModelPriceHistory** | :1937-1949 | 无写入方 |
| **DiscoveredModel** | :1913-1935 | 无写入方 |
| **PaymentQRCode / PaymentProviderAccount** | — | 无写入方 |

### 其他
- `ExchangeRate`（:174-181）：仅 exchangeRate.ts:85-89 upsert。
- `BillingTransaction`（:512-533）：仅 trace.ts:192 create；`inputTokens/outputTokens` 有接口但 credits.ts:31-41 未传。
- `ModelCall`：trace.ts:100 create（`totalApiCostUsd` 实为积分值，见前文）。

---

## 未发现的假设（nothing found）

1. **没有任何代码调用 `computeCostFromPricing`** —— `ProviderPricingVersion` 的每百万 token USD 价格从未进入任何成本计算
   （唯一命中为定义处 providerCosts.ts:92）。
2. **没有任何代码调用 `researchPrice`**，也没有 `ResearchPlan.priceResearch` 标记的消费方 —— priceResearch 模块整体是死代码。
3. **没有任何代码调用 `refundCredits`（credits.ts:47）、`reserveCredits`（billingLedger.ts:155）、`reverseCredits`（billingLedger.ts:167）**，
  也没有 `Refund` 表的写入方 → 退款/冲正/预占在这套系统里没有可执行路径。
4. **没有任何对账任务**：`computeLedgerBalance`（billingLedger.ts:172）与 `verifyBalanceConsistency`（creditLedger.ts:166）
   均无调用方，无定时核对 `sum(creditLedger.amount)` 与 `user.creditBalance` 的作业；`PaymentReconciliation` 表无写入方。
5. **没有任何 cron/定时调用 priceResearch 或外部比价 API 去影响本站售价**；`PROVIDER_COST_TABLE_JSON` 只在 index.ts:254 启动时播种一次。
6. **支付渠道侧没有任何 USD→当地货币的二次换算**：适配器只归一化入站数据，汇率仅出现在 payment.ts:43/:58。

---

## 开放问题

1. **TokenUsage 落库是否会整体失败？** `TokenUsage.provider` 是必填字段（schema-user.prisma:2245；生成的 client
   `TokenUsageCreateInput.provider: string`），但 `buildUsageRecord`（tokenUsage.ts:48-84）**没有设置 provider**，
   `tx` 被断言为 `any`（tokenUsage.ts:99）使 TypeScript 不会报错。运行时 Prisma 应抛 "Argument provider is missing"，
   且该错误不匹配 `busy` 判定（:116-119）→ 直接抛出 → `withRetry` 重试 3 次仍失败 → chat.ts:1013-1015 仅记 warn。
   若成立，则**TokenUsage 表在 chat 路径从未成功写过行**（一处待运行时验证）。
2. **双路径扣减是否在线上真实发生？** 若第 1 条成立，路径 B 的事务会整体回滚（含 decrement），
   双扣不会发生但扣费静默失败；若 provider 另有来源，则 chat.ts:989 + tokenUsage.ts:108 构成对同一请求的两次扣减。
   建议以一条 traceId 同时查 `CreditLedger` 与 `TokenUsage` 行数来判定。
3. **`user.creditBalance` 绝对覆写的竞态**：billingLedger.ts:72-77 + :133 是 read-then-write，两个并发不同 requestId 的
   请求会互相覆盖余额（丢失更新）。是否需要改为 `{ decrement }` 或加 `SELECT ... FOR UPDATE`？
4. **两套账本实现并存**：`finance/billingLedger.ts`（带 trace/batch/pricing 维度）与 `services/creditLedger.ts`
   （仅 grant/reverse）都写 `creditLedger` + `creditTransaction` + `user.creditBalance`，后者据其文件头宣称
   "ALL balance changes MUST go through this ledger"，与 R8 设计冲突。是否应下线后者？
5. **`CreditBatch.remaining` / `isActive` 从不更新**：`getActiveBatches` 按 `isActive && expiryDate > now` 过滤
   （credits.ts:108），过期批次只靠日期过滤、`remaining` 永远等于 `amount`，批次实际消耗无法追踪。
6. **`costPer1k` 的量纲与"USD 成本"命名冲突**：`ModelCall.inputCostUsd/totalCostUsd`（chat.ts:978-980、:1645-1647）
   与 `BillingTransaction.totalApiCostUsd` 实际存的是积分，财务/成本分析读取时会误判为美元。
7. **schema 漂移**：`multiplier` 在 schema-user.prisma:2247 与 :2264 重复声明，与 `migrations-user.sql`
   和已生成 client 不一致；`schema.prisma` 同样重复。`prisma generate/validate` 可能失败或掩盖其他漂移。
8. **`getRate` 回落 1 的风险**：exchangeRate.ts:106-107 在汇率缺失/异常时按 1:1 换算，
   下单金额会等于 USD 面值写进当地币订单，用户可能少付/多付；且 `PaymentVerification` 只比较数字与币种，不会发现此类错误。
