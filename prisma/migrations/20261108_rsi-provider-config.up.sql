-- RSI 独立 API 配置 + RSI 额度切换审计（knowledge 库，与普通额度零关联）
CREATE TABLE IF NOT EXISTS "RsiProviderConfig" (
  "id"            TEXT PRIMARY KEY,
  "provider"      TEXT NOT NULL,
  "tier"          TEXT NOT NULL DEFAULT 'FREE',
  "label"         TEXT NOT NULL DEFAULT '',
  "baseUrl"       TEXT NOT NULL,
  "baseUrlRoot"   TEXT,
  "apiKeys"       TEXT NOT NULL DEFAULT '[]',
  "apiLimit"      TEXT NOT NULL DEFAULT '',
  "carrierLimit"  TEXT NOT NULL DEFAULT '',
  "rsiModelLimit" TEXT NOT NULL DEFAULT '',
  "enabled"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "RsiProviderConfig_provider_tier_key" ON "RsiProviderConfig"("provider","tier");
CREATE INDEX IF NOT EXISTS "RsiProviderConfig_enabled_idx" ON "RsiProviderConfig"("enabled");

CREATE TABLE IF NOT EXISTS "RsiQuotaSwitchLog" (
  "id"        TEXT PRIMARY KEY,
  "level"     TEXT NOT NULL,
  "quotaType" TEXT NOT NULL,
  "fromApi"   TEXT NOT NULL,
  "toApi"     TEXT NOT NULL,
  "fromModel" TEXT NOT NULL,
  "toModel"   TEXT NOT NULL,
  "reason"    TEXT NOT NULL,
  "remaining" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "RsiQuotaSwitchLog_createdAt_idx" ON "RsiQuotaSwitchLog"("createdAt");
