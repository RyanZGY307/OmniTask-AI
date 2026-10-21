# 积分/会员购买：定价与金融计算链路（只读分析）

仓库：OmniTaskAI/cortex。分析方式：通读源码 + 追调用链；每条结论附 `文件:行`。
未找到证据的统一写入「未发现的假设（nothing found）」或「开放问题」。

## 函数级记录

### 1. runDailyPricingJob
- 定义：`server/src/services/finance/pricingEngine.ts:337-401`
- 入参：无。隐式输入 = 当天已发布次数（DB）、当日 USD/MYR 市场汇率、当前 active 定价版本的包/订阅价。
- 返回：`DailyPricingReport`（`pricingEngine.ts:327-335`）{ ok, published, code, marginPct, direction, detail }。
- 步骤：
  1. `publishedTodayCount()`（`pricingEngine.ts:222-226`，本地 00:00 起计数）≥ `PRICING_GUARDRAILS.maxPublishesPerDay`（1，`server/src/config.ts:694`）→ 返回 `already_published_today`，不发布（`pricingEngine.ts:338-341`）。
  2. `captureDailyFx()`（`fxVersion.ts:76-81`）失败 → 返回 `fx_fetch_failed`，**不发布**，保留上一有效 FxVersion（`pricingEngine.ts:343-347`，注释 R3.4）。
  3. `marketRate = fxCapture.version.rate`（`pricingEngine.ts:348`）。
  4. 取包价/订阅价：active 版本优先，否则 `buildBaselinePackages()`/`buildBaselineSubscriptions()`（`pricingEngine.ts:350-352`；基线构造 `pricingEngine.ts:69-100`，价格来自 `configSync` 即 CreditPack/SubscriptionPricing 表 + 硬编码默认）。
  5. 成本/收入汇总（`pricingEngine.ts:359-368`）：`cost += price × 1.15 × 4.50`；`revenue += price × marketRate`。
  6. `computeMargin(totalRevenueMyr, 1, totalCostMyr)`（`pricingEngine.ts:371`）→ `decideDirection(margin)`（`pricingEngine.ts:372`）。
  7. direction ≠ 0 → `nextCandidatePrice(price, dir)`（`pricingEngine.ts:382-383`）→ `publishPricingVersion(...)`（`pricingEngine.ts:385-391`）。
- 假设/依赖：汇率必须当日可取到（否则整天不调价）；「成本」恒为售价的 1.15×4.50 倍，与真实 provider 成本无关；每台部署实例按本地时区 00:00 判定「当天」。

### 2. publishPricingVersion
- 定义：`server/src/services/finance/pricingEngine.ts:165-220`
- 入参：`PublishCandidate`（`pricingEngine.ts:156-163`）packages/subscriptions/fxVersionId/providerPricingVersionId/reason/publisher。
- 动作：`clampPackages`/`clampSubscriptions` 把价格夹到 [基线×0.80, 基线×1.50]（`pricingEngine.ts:128-152`，系数 `config.ts:692-693`，边界计算 `safeBounds` `pricingEngine.ts:55-59`）→ `validateLadder` 单价随档位递减校验（`pricingEngine.ts:110-126`，失败即拒发 `pricingEngine.ts:169-173`）→ 事务内写 `CreditPricingVersion`（`pricingEngine.ts:189-198`：packagesJson/subscriptionJson/modelCreditsPerMJson/minSafe/maxSafePricesJson/status='active'）→ 旧 active `PricingVersion` 置 `superseded`（`pricingEngine.ts:200-203`）→ 建新 `PricingVersion`（`pricingEngine.ts:205-214`：code=`pv-<ISO14>`、fxVersionId、providerPricingVersionId、creditPricingVersionId、publisher、status='active'）。事务超时 20s（`pricingEngine.ts:217`）。

### 3. getActivePricingVersion
- 定义：`server/src/services/finance/pricingEngine.ts:230-251`
- 读：`PricingVersion where status='active' order by publishedAt desc`，include creditPricingVersion + fxVersion（`pricingEngine.ts:231-235`）。
- 返回 `ActivePricingVersion`（`pricingEngine.ts:36-47`），含 `marketRateUsdMyr = fxVersion.rate`（`pricingEngine.ts:246`）、packages/subscriptions/modelCreditsPerM（JSON 反解析 `pricingEngine.ts:247-249`）。
- 假设：DB 里存在且仅存在一条 active 版本；`fxVersion` 关系存在时才带 marketRate（否则 null）。

### 4. lockPackPricing / lockSubscriptionPricing
- 定义：`server/src/services/finance/pricingEngine.ts:291-306` / `:308-323`
- 入参：packId / tier；返回 `OrderLock`（`pricingEngine.ts:280-289`）或 null。
- 逻辑：读 active 版本 → 找到对应 pack/tier → 返回 `priceUsd=d(price)`、`credits`、四个版本 id、`marketRateUsdMyr`、`validDays`（包 90 / 订阅 30，`pricingEngine.ts:304`/`:321`）。
- 未找到：`validDays` 无任何过期强制逻辑（仅被写入 `PaymentOrder.creditValidDays`，见 `routes/payment.ts:77`，及 admin 只读展示 `routes/pricing.ts:101`）。

### 5. buildBaselinePackages / buildBaselineSubscriptions / modelCreditsPerM
- 定义：`pricingEngine.ts:69-80` / `:82-100` / `:61-67`
- 基线价来源：`getDynamicPacks()`（`configSync.ts:141-143` ← DB `CreditPack` 合并硬编码 `configSync.ts:120-139`）、`getDynamicPricing().PRO.monthly`（`configSync.ts:186-188` ← DB `SubscriptionPricing` `configSync.ts:152-184`）、`getLegacyUltraPricing().monthly`（`configSync.ts:192-194`）。ULTRA 仅供遗留订单结算，不出售（注释 `pricingEngine.ts:83-85`）。
- `modelCreditsPerM`：`ModelConfig.costPer1k × 1000`（`pricingEngine.ts:61-67`，读 `getDynamicModels()` ← DB `ModelConfig` `configSync.ts:64-103`），随版本发布持久化（`pricingEngine.ts:193`）。
- ULTRA  Grants：`getDynamicGrants()`（`configSync.ts:196-202`），订阅积分不随调价变动（`config.ts:699-706`）。

### 6. computeMargin / computePackageCost
- 定义：`server/src/services/finance/costEngine.ts:48-57` / `:26-40`
- `computePackageCost(priceUsd, protectionFactor=1.15, costFxRate=4.50)`：`protectedCostMyr = price × 1.15 × 4.50`（`costEngine.ts:31-34`）。文件头明确「无需真实 Provider API 成本数据（fictional models）」（`costEngine.ts:5-6`）。
- `computeMargin(revenueUsd, marketRate, costMyr)`：`rev = revenue × rate`；`rev ≤ 0 → 0`；否则 `(rev − cost) / rev`（`costEngine.ts:53-56`）。
- 调用点注意：`runDailyPricingJob` 传入的 revenue 已是 MYR 且 rate=1（`pricingEngine.ts:371`），即 `margin = (Σprice·rate − Σprice·1.15·4.50) / (Σprice·rate)`。
- `computePortfolioMargin`（`costEngine.ts:64-80`）为同公式的整表版，**无调用者**（本轮全仓搜索未发现引用）。

### 7. decideDirection / nextCandidatePrice / applyStep
- 定义：`server/src/services/finance/marginEngine.ts:28-33` / `:61-63`；`money.ts:84-88`
- `decideDirection`：`margin < MARGIN_LOW(0.20)` → direction=1（+5%）；`> MARGIN_HIGH(0.40)` → −1（−5%）；否则 0（hold）（`marginEngine.ts:30-32`；常量 `money.ts:18-20`、`config.ts:689-691`）。
- `applyStep(price, dir)`：`price × 1.05` 或 `× 0.95`（`money.ts:86-87`），`ADJUST_STEP=0.05`（`money.ts:20`）。
- `nextCandidatePrice` = `roundPrice(applyStep(...))`，2 位小数 HALF_UP（`marginEngine.ts:61-63`、`money.ts:32-42`）。

### 8. attribute（支付归因）
- 定义：`server/src/services/paymentAttribution.ts:55-200`
- 与定价/汇率无关：只用 providerTransactionId / orderId / providerReference / 金额±0.02 + 币种 + 30 分钟时间窗 + 身份信号打分（`paymentAttribution.ts:91-97,133-140,158-199, 204-352`）。
- 阈值：score ≥70 且领先第二名 1.4 倍 → matched；≥50 → candidate_found；否则 ambiguous（`paymentAttribution.ts:311-351`）。

### 9. verify（支付校验）
- 定义：`server/src/services/paymentVerification.ts:33-159+`
- 金额对比 `order.remainingAmount || order.expectedAmount`，容差 0.01（`paymentVerification.ts:94-111`）；币种必须严格相等（`paymentVerification.ts:113-122`）——**不做任何汇率二次换算**。

### 10. processBilling / grantCredits / applyEntry
- `processBilling`：`server/src/services/paymentRuntime.ts:384-516`。积分取 `order.lockedCredits`，为 0 时按 plan 解析（pack-N→N、legacy ultra→5000、pro→3000 每批，年付 12 批）（`paymentRuntime.ts:395-411, 448-469`）；调用 `grantCredits`（`billingLedger.ts:151-153`）写 `CreditLedger`/`CreditTransaction`/`CreditBatch` 并更新 `user.creditBalance`（`billingLedger.ts:80-133`）；幂等键 `credit_grant_${paymentId}`（年付批次追加 `_batch_i`）（`paymentRuntime.ts:429,462`）；随后订单 `verifiedTotal/remainingAmount/status`（`paymentRuntime.ts:483-493`）与订阅激活（`paymentRuntime.ts:496-498, 520-542`）。
- `applyEntry`：`billingLedger.ts:61-147`。唯一改写余额的路径（文件头 R8）；重复幂等键直接返回旧结果（`billingLedger.ts:67-70, 139-144`）；余额不足抛错（`billingLedger.ts:77-78`）；成本列 `actualCostUsd/protectedCostUsd/protectedCostMyr/creditsUsed` 统一 `roundUsd`（6 位 HALF_UP）后入库（`billingLedger.ts:56-59, 99-102`）。

### 11. convertFromUSD / getRate / fetchAndStoreRates
- 定义：`server/src/services/exchangeRate.ts:110-116` / `:100-108` / `:70-98`
- `convertFromUSD(usd, target)`：`rate = getRate(target)`；`converted = usd × rate`；小数位按 `SUPPORTED_CURRENCIES[target].decimal`（JPY/TWD/HUF=0 否则 2）round/toFixed（`exchangeRate.ts:111-115`）——**float 运算**，非 Decimal。
- `getRate(target)`：USD→1；读 `prisma.exchangeRate`（base='USD', target），缺失或异常**返回 1**（`exchangeRate.ts:101-107`）。
- `fetchAndStoreRates`：GET open.er-api.com/v6/latest/USD → upsert `ExchangeRate.rate`/`fetchedAt`（`exchangeRate.ts:85-89`）；失败仅 console.error 返回 false（`exchangeRate.ts:94-97`），无降级、无旧值保留策略。

### 12. createFxVersion / captureDailyFx / getActiveFxVersion
- 定义：`server/src/services/finance/fxVersion.ts:39-60` / `:76-81` / `:62-69`
- `fetchMarketRate`（`fxVersion.ts:24-37`）只取 USD→MYR；失败/非正数返回 null。
- `createFxVersion`：`roundRate`（10 位 HALF_UP，`money.ts:44-46`），事务内把旧 active 置 `isActive=false` 再建新行（`fxVersion.ts:44-58`）；速率 ≤0 抛错（`fxVersion.ts:41`）。
- `getActiveFxVersion`：`findFirst where baseCurrency/quoteCurrency/isActive order by fetchedAt desc`（`fxVersion.ts:62-66`）。

## 数据流（用户看到价格 → 点击支付 → 下单成功）

| # | 文件:行 | 做了什么 | 依赖什么 |
|---|---------|---------|---------|
| 1 | `client/src/app/payment/page.tsx:48-54`, `client/src/lib/models.ts:111` | 购买页展示价 = 客户端硬编码 '$9.9'/'$99' + 静态 `CREDIT_PACKS` | 无服务端依赖；与定价引擎无联系 |
| 2 | `server/src/routes/payment.ts:262-285` | `GET /api/payment/prices` 返回 `getDynamicPricing()`/`getDynamicPacks()`（priceUsd=配置价，未做汇率换算） | `configSync.ts:141/186` ← DB `CreditPack`/`SubscriptionPricing` + 硬编码 |
| 3 | `server/src/routes/pricing.ts:22-33` | `GET /api/pricing/current` 返回 active 版本 + 当日 fx（`rate.toFixed(10)`） | `pricingEngine.ts:230-251`、`fxVersion.ts:62-69`；**客户端无调用点** |
| 4 | `pricingEngine.ts:253-276` | 启动 bootstrap：无 active 版本则取/抓 FxVersion → `buildBaseline*` → `publishPricingVersion` | `configSync`、`fxVersion.ts:76-81` |
| 5 | `server/src/index.ts:283-287, 288-290` | 每日调价：setInterval 24h + 启动 60s+10s 后各跑一次 `runDailyPricingJob` | DB 可用；open.er-api.com 可达 |
| 6 | `pricingEngine.ts:337-401` | 调价决策：cost=Σprice×1.15×4.50，revenue=Σprice×rate，margin→direction→±5%→发布 | `fxVersion.ts:76-81`、`costEngine.ts:48-57`、`marginEngine.ts:28-33,61-63` |
| 7 | `server/src/routes/payment.ts:15-59` | `POST /api/payment/orders`：plan→基础 expectedAmount（`getDynamicPacks`/`getDynamicPricing`）→ `convertFromUSD` 本地化 → `lockPackPricing`/`lockSubscriptionPricing` **覆盖** expectedAmount 为 active 版本价 | `exchangeRate.ts:110-116`、`pricingEngine.ts:291-323`；lock 为 null 时静默回落静态价（`:50-59`） |
| 8 | `server/src/routes/payment.ts:64-92` | 创建 `PaymentOrder`（存 pricingVersionId/fxVersionId/providerPricingVersionId/creditPricingVersionId/lockedPriceUsd/lockedCredits/creditValidDays/expiresAt=15min）+ `Payment(PENDING)` | Prisma 事务 |
| 9 | `server/src/routes/payment.ts:143-165` | 上传凭证：过期校验 → `computeSHA256` 去重 → `paymentProof` → `preCheckProof`（OCR） | `paymentReview.ts` |
| 10 | `paymentRuntime.ts:277-380` | `processProofPayment`：构造 normalized → `processPayment`；归因失败但订单归属当前用户则强制 MANUALLY_MATCHED 并重跑 verify | `paymentAttribution.ts:55-200`、`paymentVerification.ts:33+` |
| 11 | `paymentRuntime.ts:384-516` | `processBilling`：`grantCredits`（CreditLedger+CreditBatch）→ 订单 paid/underpaid → 订阅激活 | `billingLedger.ts:61-147` |
| 12 | `paymentRuntime.ts:82-104` | 另有一条 provider 推送入口 `processPayment`（幂等键 `provider:txnId:payment`） | 同上 |

## 汇率与成本来源

- **两套独立汇率体系**：
  1. `ExchangeRate` 表（全币种，USD 基础）：源 open.er-api.com（`exchangeRate.ts:72`），`startRateUpdater` 启动 5s 后抓一次、之后每 24h（`exchangeRate.ts:130-136`）；admin 也可手动触发 `GET`/刷新（`routes/currency.ts:47`）。**无版本号、无 active 标记、无 TTL/过期策略**，upsert 直接覆盖（`exchangeRate.ts:85-89`）；拉取失败不阻塞任何购买路径（仅返回 false）。用于：下单时本地化金额（`routes/payment.ts:43,58`）、`convertFromUSD`（`routes/currency.ts:56`）。
  2. `FxVersion` 表（仅 USD→MYR）：不可变快照 + isActive 布尔；`roundRate` 10 位（`fxVersion.ts:39-60`）；仅在 `runDailyPricingJob`（`pricingEngine.ts:343`）与 bootstrap（`pricingEngine.ts:260-266`）时创建；失败则阻止当日发布并保留上一版（`pricingEngine.ts:344-347`）。用于：margin 计算的市场汇率、`OrderLock.marketRateUsdMyr`、`PricingVersion.fxVersionId` 关联、`/pricing/current` 展示。
- **成本来源**：不是 provider 成本。`costEngine.ts:5-6` 与 `money.ts:15-16` 定义固定公式 `cost = 售价USD × 1.15 × 4.50`（`protectionFactor`/`costFxRate` 亦可由 `PRICING_GUARDRAILS` 传参，`config.ts:695-696`）。真实 provider token 成本走 `ProviderPricingVersion` 表（`providerCosts.ts:23-58`，env `PROVIDER_COST_TABLE_JSON` 种子 `:73-88`，按 token 计费 `computeCostFromPricing :92-107`），但**与销售定价链路无连接**（发布时 `providerPricingVersionId` 恒 null：`pricingEngine.ts:272, 389`）。

## margin 与调价决策

- **公式**：`margin = (Σ(price_i × marketRate) − Σ(price_i × 1.15 × 4.50)) / Σ(price_i × marketRate)`（计算点 `pricingEngine.ts:359-371`；单条价格版 `computePackageCost` `costEngine.ts:26-40` + `computeMargin` `costEngine.ts:48-57`；等价实现 `money.ts:78-82` grossMargin）。
- **调价决策**：`decideDirection`（`marginEngine.ts:28-33`）：margin < 20% → +5%；> 40% → −5%；20–40% → 不动。步长 `ADJUST_STEP=0.05`（`money.ts:20`、`config.ts:691`）；`nextCandidatePrice`（`marginEngine.ts:61-63`）→ 2 位 HALF_UP → `publishPricingVersion` 内再夹到基线 0.80–1.50× 并做阶梯校验（`pricingEngine.ts:128-152, 110-126`）。
- **触发条件**（问 D）：定期任务（`index.ts:283-287` 每 24h；`index.ts:288-290` 启动一次）+ 管理员手动（`POST /api/pricing/admin/run`，`routes/pricing.ts:36-44`）+ 每天最多 1 次（`pricingEngine.ts:222-226, 338-341`）。**没有**成本阈值、**没有**汇率绝对阈值、**没有** provider 成本驱动的调价（见 nothing found）。
- **手动改价入口（另一条，不走 PricingVersion）**：admin 写 `CreditPack`（`routes/admin.ts:722-759` upsert/update/软删 isActive）与 `SubscriptionPricing`（`routes/admin.ts:768-785` upsert），随后 `refreshCreditPacks`/`refreshSubscriptionPricing` 清缓存（`configSync.ts:145-148, 204-208`）。这类改动进入 `getDynamicPacks`/`getDynamicPricing`，成为**下一次 bootstrap/发布**的基线，不影响已 active 版本（已锁订单不变）。
- **写入目标**：新价格只写入 `CreditPricingVersion.packagesJson/subscriptionJson` + `PricingVersion`（`pricingEngine.ts:189-214`）；订单侧写入 `PaymentOrder.lockedPriceUsd` 等（`routes/payment.ts:71-77`）。

## 未发现的假设（nothing found）

1. **展示价与锁定价之间没有任何一致性校验**：购买页价格是客户端硬编码常量（`client/src/app/payment/page.tsx:48-54`、`client/src/lib/models.ts:111`），服务端权威价（active PricingVersion）只用于下单锁定（`routes/payment.ts:57`）；`GET /pricing/current`（`routes/pricing.ts:22-33`）在客户端无任何调用点。用户看到的价格与实付价格可能不同，代码中无对账/警告逻辑。
2. **没有「成本上涨→调售价」的触发器**：成本恒 = 售价 ×1.15×4.50（`pricingEngine.ts:361,366`、`costEngine.ts:31-34`），不存在独立成本输入或成本阈值；`decideDirection` 只认 margin 区间，无汇率阈值；`ProviderPricingVersion`（真实 provider 成本，`providerCosts.ts:45-58`）与 `PricingVersion` 发布之间无代码连接（`providerPricingVersionId` 恒为 null）。
3. **不存在 `BillingLedger` 表/模型**：schema 无此模型（`server/prisma/schema.prisma`）；账务实际表为 `CreditLedger`（含 `pricingVersionId/protectedCostUsd/protectedCostMyr` 等列），唯一写入方 `billingLedger.ts:61-147`。
4. **`OrderLock.validDays`（90/30）无强制逻辑**：仅写入 `PaymentOrder.creditValidDays`（`routes/payment.ts:77`）与 admin 只读展示（`routes/pricing.ts:101`）；没有任何地方比较下单时间与该有效期；实际批次过期时间用的是硬编码 `PERMANENT_PACK_VALID_DAYS`/30（`paymentRuntime.ts:432,445,465`）。
5. **`ExchangeRate` 无过期/降级策略**：只有 `fetchedAt`（schema `ExchangeRate`），无 TTL 判定；`fetchAndStoreRates` 失败仅日志（`exchangeRate.ts:94-97`）；`getRate` 缺失返回 1（`exchangeRate.ts:106-107`）会静默把本地金额当作等于 USD 数值。
6. **`REFERENCE_PACK_ID`**（`pricingEngine.ts:49`）定义后无任何使用；`TARGET_MARGIN=0.30`（`money.ts:17`、`config.ts:688`）未参与 `decideDirection`。
7. **`computePortfolioMargin`**（`costEngine.ts:64-80`）无调用者。

## 开放问题

1. `targetMargin=0.30` 与「20–40% 区间 hold」并存（`config.ts:688` vs `marginEngine.ts:30-32`）：预期是趋向 30% 收敛还是仅区间保持？当前不会因接近 30% 而微调。
2. 双价格源（`/payment/prices` 配置价 vs `/pricing/current` 版本价）+ 客户端硬编码展示，三者可能不一致（尤其订单 15 分钟窗口内发布新版本时，`routes/payment.ts:62` vs `pricingEngine.ts:205-214`）：是否有意让 UI 长期显示旧价？是否应统一到 `/pricing/current`？
3. `client/src/app/settings/payment/page.tsx:68,79` 调用的 `/payment/submit`、`payment/proof/:paymentId` 在服务端不存在（`routes/payment.ts` 仅 `/orders`、`/prices`、`/methods`、`/orders/:orderId/proofs`、`/orders/:orderId/cancel`）：遗留死代码，还是路由缺失导致该页购买功能实际不可用？
4. `providerPricingVersionId` 恒 null + `costEngine.ts:5-6` 自称 fictional models：销售定价与真实 provider 成本解耦是设计决定（R1.3/R1.4 的 review 语义是否只作用于用量计费）？若 provider 涨价，系统中没有任何地方会反映到售价。
5. 精度边界：`convertFromUSD` 用 float 乘法 + `toFixed`（`exchangeRate.ts:114-115`）、`PaymentOrder.lockedPriceUsd`/`expectedAmount` 为 Float 列（schema `PaymentOrder`）、`orderLock.priceUsd.toNumber()`（`routes/payment.ts:57`）——与 `money.ts:1-8` 的「全程 Decimal（R10.1）」声明存在张力；是否需要在锁价与本地化两步引入 Decimal/舍入策略评审？
6. `processBilling` 返回 `balanceAfter: order.lockedCredits ? creditsToGrant : creditsToGrant`（`paymentRuntime.ts:515`）两分支同值，疑为笔误（其余分支用的是 `result.balanceAfter`，`paymentRuntime.ts:434,447,467`）——对外回显的余额是否应取批次后的真实余额？
