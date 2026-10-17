# Dynamic Credit Pricing and FX Margin System Requirements

## Introduction

该功能为 CortexAI 建立一套可审计的动态积分定价与汇率利润控制系统。系统基于真实 Provider Token Usage 计算成本，使用固定 4.50 汇率保护成本，使用市场汇率计算收入，并围绕 30% 目标毛利率执行每日一次的价格调整。所有订单永久锁定创建时价格，所有账务通过 Billing Ledger 修改，禁止直接改余额。

## Glossary

- **Protected Cost**: 实际 Provider API 成本乘以 1.15 后的 USD 成本。
- **Protected Cost MYR**: Protected Cost 按固定 1 USD = RM4.50 转换后的成本。
- **Revenue MYR**: 用户售价 USD 按当日市场 USD/MYR 汇率转换后的收入。
- **Gross Margin**: (Revenue MYR - Protected Cost MYR) / Revenue MYR。
- **Pricing Version**: 某一刻所有积分包价格、模型积分费率、成本保护的不可变版本。
- **FX Version**: 每日市场汇率快照版本。
- **Provider Pricing Version**: 各 Provider 成本参数版本。
- **Credit Pricing Version**: 积分包价格与模型积分费率版本。
- **Billing Ledger**: 唯一允许修改积分余额的账本。

## Requirements

### R1. 真实成本采集

1. THE system SHALL 从 ModelCall 与 RequestTrace 的真实 input/output tokens 计算 Provider 实际成本。
2. THE system SHALL 使用 USD 最小单位整数或 Decimal 字符串保存成本，禁止用 Float 保存金额。
3. IF Provider cost data is missing for a model call, THE system SHALL block billing closure and flag the request for review.
4. THE system SHALL NOT 在成本缺失时默认成本为 0。

### R2. 成本保护与固定汇率

1. THE system SHALL 将实际 API 成本乘以 1.15 得到 Protected Cost USD。
2. THE system SHALL 将 Protected Cost USD 按固定汇率 4.50 转换为 Protected Cost MYR。
3. THE system SHALL NOT 使用实时市场汇率计算成本。

### R3. 收入与市场汇率

1. THE system SHALL 每日获取 USD/MYR 市场汇率。
2. THE system SHALL 为每个成功获取的汇率创建不可变 FX Version。
3. THE system SHALL 将 Revenue MYR 计算为 Customer Price USD × 当日市场汇率。
4. IF the daily FX fetch fails, THE system SHALL block new pricing release and keep the last valid FX Version.

### R4. 毛利率控制

1. THE system SHALL calculate Gross Profit as Revenue MYR - Protected Cost MYR.
2. THE system SHALL calculate Gross Margin as Gross Profit / Revenue.
3. WHEN the current margin is below 20%, THE system SHALL increase candidate prices by 5%.
4. WHEN the current margin is above 40%, THE system SHALL decrease candidate prices by 5%.
5. WHILE the current margin is between 20% and 40%, THE system SHALL keep prices unchanged.
6. THE system SHALL allow at most one pricing adjustment per day.

### R5. 动态定价与安全边界

1. THE system SHALL 创建新的 Pricing Version 前执行安全检查。
2. THE system SHALL 为每个积分包设置最低安全价格。
3. IF a candidate price is below the minimum safe price, THE system SHALL clamp the price to the minimum safe price.
4. IF a candidate price exceeds a configured maximum guardrail, THE system SHALL clamp the price to the maximum guardrail.
5. THE system SHALL NOT 允许 LLM 直接决定最终价格。

### R6. 历史订单锁定

1. THE system SHALL save pricing_version, fx_rate_version, provider_pricing_version, and credit_pricing_version on every order.
2. THE system SHALL save the final customer price and credit amount on every order.
3. THE system SHALL NOT recalculate historical order prices after a later pricing version is published.
4. THE system SHALL support restoring the exact price and cost context of any historical order from saved versions.

### R7. 积分包定价

1. THE system SHALL use the initial credit package ladder: 300=$1.99, 600=$2.99, 1200=$4.99, 2400=$8.99, 5000=$16.99, 10000=$28.49, 15000=$50.99.
2. WHEN adjusting prices automatically, THE system SHALL change package prices only and keep credit quantities unchanged.
3. THE system SHALL validate that the unit credit price of a larger package is less than or equal to the unit credit price of a smaller package.
4. IF the package ladder check fails, THE system SHALL reject the new Pricing Version and keep the active version.

### R8. Billing Ledger

1. THE system SHALL record every AI usage event with provider, model, input tokens, output tokens, total tokens, actual API cost, protected cost, credits used, trace ID, and request ID.
2. THE system SHALL modify credit balances only through Billing Ledger operations.
3. THE system SHALL support Reserve, Charge, and Refund operations.
4. THE system SHALL use an idempotency_key to prevent duplicate credit grants and duplicate charges.

### R9. Payment attribution and credit grant

1. THE system SHALL treat payment matching as attribution before verification and credit grant.
2. THE system SHALL capture Transaction ID, Order Reference, Provider Account, Amount, Currency, Timestamp, Payment Method, Phone/Email, and Display Name as first-class evidence.
3. THE system SHALL use recipient name only as supporting evidence.
4. IF payment attribution is ambiguous, THE system SHALL route the payment to manual review and block automatic credit grant.

### R10. 财务安全

1. THE system SHALL represent all financial amounts as Decimal or integer minor units.
2. THE system SHALL NOT allow LLM code paths to modify credit balances.
3. THE system SHALL NOT allow the client to compute the authoritative final price.
4. THE system SHALL NOT store passwords, API keys, access tokens, or secret provider credentials in pricing or billing records.

## Acceptance Criteria

- WHEN a model request completes, THE Billing Ledger SHALL contain one charge record with real usage, protected cost, and credits used.
- WHEN a credit package order is created, THE order SHALL contain immutable price, credit amount, and four version identifiers.
- WHEN a daily pricing job runs, THE system SHALL produce at most one new Pricing Version.
- WHEN a package ladder check fails, THE active Pricing Version SHALL remain unchanged.
- WHEN a duplicate payment idempotency_key appears, THE system SHALL reject the duplicate instead of granting credits again.

## R11. 订阅 (Pro/Ultra) 定价与积分有效期

1. THE system SHALL 对 Pro/Ultra 订阅购买执行与积分包购买相同的闭环：订单锁价、版本快照（R6 中四个版本 ID）与 Billing Ledger 信用发放。
2. THE system SHALL 在每笔订阅订单上永久保存 `price`、`credit grant`、`pricing_version`、`fx_rate_version`、`provider_pricing_version`、`credit_pricing_version`。
3. THE system SHALL 将订阅赠送积分有效期固定为 30 天。
4. THE system SHALL 将积分包购买所得积分有效期固定为 90 天。
5. THE system SHALL 在 Pricing Version 中为 Pro/Ultra 订阅价格执行最低安全价、最高安全价与阶梯检查。
6. WHEN 每日动态调价发布新的 Pricing Version 时，THE system SHALL 仅调整订阅价格，订阅 credit grant 数量保持不变。
