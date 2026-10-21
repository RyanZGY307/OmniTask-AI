# fx-margin-money — 结构化事实记录（只读审计，无源码修改）

审计对象：汇率版本 / 毛利引擎 / 金额工具 / 成本引擎（+ exchangeRate 服务、currency 路由、creditFormula）。
行号格式：`文件:行`，路径相对仓库根 `OmniTaskAI/cortex/`。
规则：每条断言必须带行号；断言不了的写「未找到」。

---

## 模块级事实

### server/src/services/finance/fxVersion.ts（87 行）
- 汇率来源：`fetch('https://open.er-api.com/v6/latest/USD')`，取 `data.rates[quote]`，要求 `result==='success'` 且 rate 为有限正数（fxVersion.ts:24-37）。货币对固定 USD/MYR（fxVersion.ts:13-15）。
- 落库：`createFxVersion` 在 20s 交互事务内先把同 (base,quote) 的 `isActive:true` 行批量置 false，再 create 新行（fxVersion.ts:44-58）。rate 写入前 `roundRate` → 10 位小数（fxVersion.ts:40；RATE_SCALE=money.ts:25）。
- 读取：`getActiveFxVersion` 每次直查 DB `findFirst`（isActive:true, fetchedAt desc），无内存缓存（fxVersion.ts:62-69）。
- 每日快照入口：`captureDailyFx` = fetch + create，失败返回 `{ok:false,reason:'fetch_failed'}`（fxVersion.ts:76-81）。
- 展示兜底：`getRateNumber` 取不到返回 1，注释明示「Never used for cost」（fxVersion.ts:83-87）。
- 存储形态：Prisma 表 `FxVersion`（schema-user.prisma:1313-1325）：`rate Float`、`isActive Boolean @default(true)`、时间 `fetchedAt`。DDL 里 rate 是 `DOUBLE PRECISION`（migrations-user.sql:1187），索引非唯一（migrations-user.sql:2538）。
- 消费方把版本钉在订单上：`PricingVersion.fxVersionId` 外键（schema-user.prisma:1359-1360）→ `OrderLock` 复制 `fxVersionId` + `marketRateUsdMyr`（pricingEngine.ts:282,292-306）→ 订单落 `order.fxVersionId`（payment.ts:72）→ 管理端可回放（pricing.ts:104,113-116）。

### server/src/services/finance/marginEngine.ts（65 行）
- `decideDirection(margin)`：`margin<0.20 → +1（+5%）`；`>0.40 → -1（-5%）`；否则 0（marginEngine.ts:28-33）。阈值来自 money.ts:18-19（MARGIN_LOW/MARGIN_HIGH）。
- `computeRowMargin(key, priceUsd, costMyr, marketRate)`：revenue = `revenueMyr(priceUsd, marketRate)`，margin = `grossMargin(revenue, costMyr)`（marginEngine.ts:43-52）。
- `aggregateMargin(rows)`：先汇总 Σrevenue、Σcost 再一次性算毛利率（marginEngine.ts:54-59）。
- `nextCandidatePrice`：`roundPrice(applyStep(price, dir))`，步长 ±0.05（marginEngine.ts:61-63；money.ts:20,84-88）。
- 返回 `MarginDecision {direction, margin, reason}`，reason 带百分比文案（marginEngine.ts:22-33）。
- 注意：margin 本身无 clamp；价格上下限在 pricingEngine 侧（min/maxSafePriceUsd，config.ts:692-693，clampPackages pricingEngine.ts:128-139）。

### server/src/services/finance/money.ts（109 行）
- 类型纪律：一切金额用 `Prisma.Decimal`，禁用 JS number 运算（money.ts:5-7）；`d()` 把 null/undefined 归 0（money.ts:27-30）。
- 常量（spec R2/R4）：保护系数 1.15、固定成本汇率 4.50、目标毛利 0.30、区间 [0.20,0.40]、步长 0.05（money.ts:15-20）。
- 舍入：全部 `ROUND_HALF_UP`（money.ts:33）。USD=6 位、价格=2 位、汇率=10 位（money.ts:23-25,36-46）。
- 公式：`protectedCostUsd = roundUsd(costUsd×1.15)`（money.ts:64-66）；`protectedCostMyr = roundUsd(protectedCostUsd×4.50)`（money.ts:68-70）；`revenueMyr = roundUsd(priceUsd×marketRate)`（money.ts:73-75）；`grossMargin = (rev-cost)/rev`，rev≤0 返回 0（money.ts:78-82）。
- 小单位：`toMinor/fromMinor`（bigint，money.ts:91-97）；`clamp()` 存在但本组模块无调用（money.ts:48-53）。

### server/src/services/finance/costEngine.ts（80 行）
- 成本不是 provider 真实价：`computePackageCost` = 套餐 USD 价 × 1.15 × 4.50（costEngine.ts:26-40；头注释 costEngine.ts:5-6 自述「fictional models，无需真实 Provider 成本」）。
- `computeMargin(revenueUsd, marketRate, costMyr)=(revenueMyr-cost)/revenueMyr`，revenue≤0→0（costEngine.ts:48-57）。
- `computePortfolioMargin` 循环里**写死** `price.times(1.15).times(4.50)`（costEngine.ts:76），汇总后转调 computeMargin（costEngine.ts:79）。与 money.ts 的常量、config.ts:695 的 `costProtectionFactor` 三处重复定义同一数值。

### server/src/services/exchangeRate.ts（140 行，对外展示链路）
- 同一家 API `open.er-api.com`，但落另一张表 `ExchangeRate`（base=USD, target=code, rate Float）（exchangeRate.ts:70-98；schema-user.prisma:174-181）。
- 取数：`getRate` 每次查 DB，miss/异常都 `return 1`（exchangeRate.ts:100-108）；`getAllRates` 同理兜底 `{USD:1}`（exchangeRate.ts:118-125）。
- 无 TTL 缓存；刷新靠启动 5s + 每 24h setInterval（exchangeRate.ts:130-136，index.ts:221；手动 POST /currency/refresh，currency.ts:45-50）。
- `convertFromUSD` 用 `usdAmount*rate` 的 JS number 浮点 + `toFixed(货币小数位)`（exchangeRate.ts:110-116）。

### server/src/routes/currency.ts（76 行）
- 6 个端点全走 exchangeRate service：supported / rates / preference / payment-methods / refresh / preview（currency.ts:8-75），全部 try-catch 返 500。
- `/preview` 的 rate 是反算 `localAmount/usdAmount`（已四舍五入过的值），PayPal 手续费 4.4%（currency.ts:52-61；feePercent 定义 exchangeRate.ts:43-45）。

### server/src/services/billing/creditFormula.ts（68 行）
- 积分公式（纯函数无 I/O）：`credits/1M = totalCost×556`，其中 `totalCost = input+cacheHit+cacheMiss+output`，四项均为 $/1M token（creditFormula.ts:4-6,41-48,51-63）。556 = (total/0.01)×5.56，即 1 积分 ≈ $0.01/5.56。
- `roundCredits` 三舍四入：第一位小数 ≤0.3+1e-9 向下、否则 +1；负值 clamp 0；NaN→0（creditFormula.ts:20-29）。
- `costPer1kOf(creditsPer1M)=creditsPer1M/1000`，语义是「每千 token 多少积分」（creditFormula.ts:65-68）。
- 测试见 server/test/creditFormula.test.ts：372.2→372、372.3→372、372.4→373、372.9→373、0→0、负 5.7→0（test:26-33）；$73.50→40866、$0.70→389、$1.27→706、$15.33→8524、$0→0（test:40-48）；`costPer1kOf(40866)=40.866`、`costPer1k×1000=credits/1M` 往返（test:55-57）。

---

## 汇率版本化与缓存机制
1. 版本化 = 不可变快照行：每次成功抓取新增一行 FxVersion，旧的 isActive 翻 false（fxVersion.ts:44-58）。版本号对外就是行的 `id`（cuid）+ 通过 `PricingVersion.fxVersionId` 引用（schema-user.prisma:1359-1360）。
2. 「同一版本内汇率不变」的保证是**引用式**的：定价版本和订单锁复制 fxVersionId 与 marketRateUsdMyr（pricingEngine.ts:282,303,320；payment.ts:72），回放读原行（pricing.ts:113-116）。DB 层**没有任何约束**保证同一 (base,quote) 只有一行 isActive——只有一个非唯一索引（migrations-user.sql:2538）；反萨斯靠 createFxVersion 事务内先批量置 false（fxVersion.ts:45-48），若该事务失败/并发两条，理论上可并存多个 active。
3. 写入者与时机：`captureDailyFx`（fxVersion.ts:76-81）被 `runDailyPricingJob` 调（pricingEngine.ts:343）、`bootstrapInitialPricingVersion` 无 active 版本时调（pricingEngine.ts:260-266）；调度在 index.ts:283-290（24h interval + 启动 ~60s 一次），另有管理端路由触发（pricing.ts:38）。
4. TTL：fxVersion 读取**无任何缓存**（fxVersion.ts:63 每次 DB），所谓 TTL 只有 24h 刷新节奏（index.ts:287；exchangeRate.ts:134）。展示链路 ExchangeRate 同样无缓存兜底为 1（exchangeRate.ts:100-108）。
5. 取不到汇率的兜底分层：fetch 失败→null（fxVersion.ts:33-36）→ 每日任务直接中止并保留上一有效版本、阻止发布（pricingEngine.ts:344-347）；`getActiveMarketRate`→null（fxVersion.ts:71-74）；仅展示用 `getRateNumber`→1（fxVersion.ts:83-87）。外汇局展示链路静默 fallback 1（exchangeRate.ts:106-107,124）。

## margin 公式与钳制
- 精确公式：`grossMargin = (revenue − cost) / revenue`，`revenue = roundUsd(priceUsd × marketRate)`（money.ts:73-82；被 marginEngine.ts:50,58 与 costEngine.ts:53-56 重复实现）。revenue≤0 时返回 0（money.ts:80；costEngine.ts:55）。
- 输入分类：售价=priceUsd（美元）；成本=costMyr（马币，来自套餐价×4.50×1.15）；配置常量=MARGIN_LOW 0.20 / MARGIN_HIGH 0.40 / ADJUST_STEP 0.05（money.ts:18-20），价格安全区 0.80–1.50×（config.ts:692-693）。
- 钳制：margin 值本身**无**上下限钳制，`clamp()` 在本组模块无调用（未找到）；钳制发生在「方向决策」（阈值区间，marginEngine.ts:30-32）和「新价落地」处的 min/maxSafePriceUsd（pricingEngine.ts:128-152）与 2 位小数取整（marginEngine.ts:62）。

## 金额舍入与精度
- 单位：Decimal 主单位（USD/MYR），辅以 bigint 小单位转换（money.ts:91-97）；积分是另一套单位（creditFormula，1 积分 = totalCost×556 的倒数关系）。
- 舍入方向：一律 `ROUND_HALF_UP`（money.ts:33）；档位：USD/中间额 6 位、价格 2 位、汇率 10 位（money.ts:23-46）。发生点：写 FX 版本前（fxVersion.ts:40）、revenue/protectedCost 计算后（money.ts:65,69,74）、调价后（marginEngine.ts:62）、发布前 toFixedString(…,2)（pricingEngine.ts:382-383）。
- 积分侧完全不同：`roundCredits` 是「三舍四入」——只看第一位小数，≤0.3 向下、≥0.4 向上，且带 1e-9 epsilon 处理 372.3 浮点误差（creditFormula.ts:26-28，test:27）。
- 浮点处理：finance 侧用 Decimal 全程（money.ts:5-7）；但**落库列是 Float/DOUBLE PRECISION**（FxVersion.rate schema-user.prisma:1317 / migrations-user.sql:1187；ExchangeRate.rate schema-user.prisma:178），createFxVersion 写入还转了一次 `value.toNumber()`（fxVersion.ts:53）。creditFormula 全程 JS number 运算，仅在 .3 边界设了 epsilon（creditFormula.ts:46,28），其它边界（如 .4 附近）无保护。

## 成本来源
- 本组 costEngine：成本 = 套餐 USD 价 × 1.15 × 4.50，非 provider 报价（costEngine.ts:5-6,26-40,76）。保护系数/固定汇率三处硬编码重复（money.ts:15-16 / costEngine.ts:28-29,76 / config.ts:695）。
- 真实 provider 成本在**另一条线**：`ProviderPricingVersion` 表 + 环境变量 `PROVIDER_COST_TABLE_JSON`，逐 provider 版本化（providerCosts.ts:60-88,34-58）；`computeCostFromPricing` 按 $/1M token 计价，参数缺失返 null 绝不默认 0（providerCosts.ts:90-107）。costEngine 未引用它（未找到 import 关系）。
- costPer1k 语义与来源：`costPer1kOf = creditsPer1M/1000`，单位是**积分/千 token**，非货币（creditFormula.ts:65-68）。模型注册表上的 costPer1k 字段（client/src/lib/models.ts:5；DB 同步 configSync.ts:84）；反向换算 `modelCreditsPerM = d(costPer1k)×1000` 落 CreditPricingVersion（pricingEngine.ts:61-67,193）。前端按 `Math.round(costPer1k×1000)` 显示 ♦/1M（client/src/components/ModelSelector.tsx:46）。

## 模块间调用链
```
fetch open.er-api.com ─► captureDailyFx(pricingEngine/index)
                            ├─ createFxVersion ─► money.roundRate/d ─► DB FxVersion
runDailyPricingJob ─► captureDailyFx(fxVersion)               [index.ts:283-290 每日]
                    ├─ 套组价 ×4.50×1.15 = 成本；×marketRate = 收入（pricingEngine.ts:356-368）
                    ├─ costEngine.computeMargin ─► costEngine.ts:53-56（等于 money.grossMargin 副本）
                    ├─ marginEngine.decideDirection ─► money 常量 0.20/0.40
                    └─ 新价 = marginEngine.nextCandidatePrice ─► money.applyStep/roundPrice ─► clamp ─► publish(PricingVersion+CreditPricingVersion)
lockPackPricing/ lockSubscriptionPricing ─► OrderLock{fxVersionId, marketRateUsdMyr} ─► payment.ts:51 ─► order 钉版本
exchangeRate.ts ─► ExchangeRate 表 ─► currency.ts 路由（展示/结账链，与 finance/* 无 import 关系）
creditFormula.ts：src 内无调用方（仅 test/creditFormula.test.ts）， priced chain 之外
```
- marginEngine 的 `aggregateMargin/computeRowMargin` 被 pricingEngine import（pricingEngine.ts:17）但当前每日流程实际用的是 costEngine.computeMargin（pricingEngine.ts:371）——两套毛利公式并存。

## 未发现的假设（nothing found）
1. **「同一 (base,quote) 只有一行 isActive」无 DB 约束**：仅靠应用层事务内置 false（fxVersion.ts:45-48）；无 partial unique index、无 migration 保证（migrations-user.sql:2538 为非唯一索引）。并发/事务失败时可出现多 active，`getActiveFxVersion` 只按 fetchedAt 取第一条（fxVersion.ts:63-66）。
2. **costEngine/providerCosts 的保护系数没有单一事实源**：1.15 与 4.50 在 money.ts:15-16、costEngine.ts:28-29,76、config.ts:695 各写一遍；costEngine 不 import money 常量，改配置不会传导到这里（costEngine.ts:26-40）。
3. **calculateCreditsPer1M / costPer1kOf 在 src 中无任何调用方**：只有定义与测试（creditFormula.ts:35,66；test:11-13,40-57）；生产链上模型积分来自 `d(costPer1k)×1000` 的反向合并（pricingEngine.ts:64），意味着 556 系数与三舍四入在生产路径上**从未被执行**。
4. margin 无 clamp、无下限 0：margin 可为负（ revenue>cost 不构成前置），decideDirection 对负值只会给 +1（marginEngine.ts:30）。
5. fxVersion 无 TTL/缓存：每次读库（fxVersion.ts:63），高并发下无请求合并（未找到缓存层）。

## 开放问题
1. FxVersion.rate/ExchangeRate.rate 用 Float 落库与 money.ts「金额永不用 Float」的纪律相抵（schema-user.prisma:1317,178 vs money.ts:5-7）；10 位小数在 DOUBLE PRECISION 里的有效精度是否够（open.er-api 原始价 ~4.x，多位小数）？写库前 `toNumber()`（fxVersion.ts:53）是否引入额外误差未量化。
2. creditFormula 的 556 与三舍四入在生产无调用方：那么「每模型积分定价」的权威来源到底是 costPer1k 注册表、还是应从 provider 成本经 creditFormula 重算（providerCosts.ts + creditFormula.ts 未接线）？
3. marginEngine 与 costEngine 两套 grossMargin 并存（money.ts:78 / costEngine.ts:53-56 / pricingEngine.ts:371）：日常定价用哪套、两者的差异（costEngine 不收 revenue 舍入、用原始乘积）是否会造成口径漂移？
4. 展示链 fallback=1（exchangeRate.ts:106-107）：汇率抓取失败时用户按 1:1 看到美元等值，是否需要显式告警？（TNG/ShopeePay 等本地支付金额由它决定）
