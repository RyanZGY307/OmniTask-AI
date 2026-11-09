-- 第三级额度体系：并发许可 Lease（user 库）
CREATE TABLE IF NOT EXISTS "ConcurrencyLease" (
  "id"         TEXT PRIMARY KEY,
  "leaseKey"   TEXT NOT NULL UNIQUE,
  "holderId"   TEXT NOT NULL,
  "tier"       TEXT NOT NULL DEFAULT 'FREE',
  "scope"      TEXT NOT NULL DEFAULT 'api',
  "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "ConcurrencyLease_expiresAt_idx" ON "ConcurrencyLease"("expiresAt");
CREATE INDEX IF NOT EXISTS "ConcurrencyLease_leaseKey_releasedAt_idx" ON "ConcurrencyLease"("leaseKey","releasedAt");

-- 普通额度自动切换记录（user 库）
CREATE TABLE IF NOT EXISTS "QuotaSwitchLog" (
  "id"         TEXT PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS "QuotaSwitchLog_createdAt_idx" ON "QuotaSwitchLog"("createdAt");
CREATE INDEX IF NOT EXISTS "QuotaSwitchLog_level_quotaType_idx" ON "QuotaSwitchLog"("level","quotaType");
