-- ================================================================
-- 模型/供应商重构迁移（user DB）
--   1) provider_connection：免费/Pro 完全分离 → 复合主键 (provider, tier)
--      新增列 tier / api_limit（单API限速） / carrier_limit（运营商限速）
--   2) model_config：新增 vendor（厂商分类） / rate_limit（调用模型限速）
-- 限速三列以 JSON 存 RateLimitBlock；空串 = 无限。
--
-- 生产用 `npx prisma db push --schema prisma/schema-user.prisma` 亦可自动生成
-- 上述 DDL；本脚本用于显式/手动执行（幂等：已存在则跳过）。
-- ================================================================

-- 1) provider_connection 新增列
ALTER TABLE "provider_connection" ADD COLUMN IF NOT EXISTS "tier" TEXT NOT NULL DEFAULT 'FREE';
ALTER TABLE "provider_connection" ADD COLUMN IF NOT EXISTS "api_limit" TEXT NOT NULL DEFAULT '';
ALTER TABLE "provider_connection" ADD COLUMN IF NOT EXISTS "carrier_limit" TEXT NOT NULL DEFAULT '';

-- 去掉旧单列主键，改为 (provider, tier) 复合主键
ALTER TABLE "provider_connection" DROP CONSTRAINT IF EXISTS "provider_connection_pkey";
ALTER TABLE "provider_connection" ADD CONSTRAINT "provider_connection_pkey" PRIMARY KEY ("provider", "tier");

-- 2) model_config 新增列
ALTER TABLE "model_config" ADD COLUMN IF NOT EXISTS "vendor" TEXT NOT NULL DEFAULT '';
ALTER TABLE "model_config" ADD COLUMN IF NOT EXISTS "rate_limit" TEXT NOT NULL DEFAULT '';

-- 说明：
--   · 已有 provider_connection 行自动落 tier='FREE'（免费层），Pro 层由 admin 新建。
--   · api_keys 无数量上限（应用层不再截断到 30）。
--   · 若旧库 api_keys 列不存在（全新库），prisma db push 会一并建表；本脚本不重复建表。
