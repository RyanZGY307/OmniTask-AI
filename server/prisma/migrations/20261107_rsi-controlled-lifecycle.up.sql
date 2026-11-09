-- ================================================================
-- 受控 RSI（Controlled RSI）资产层启用迁移
-- 幂等：IF NOT EXISTS；不 DROP 任何已有表；不带数据迁移。
-- 目标库：knowledge（@@id/表名即 model 名，全仓 @@map=0）
-- ================================================================

CREATE TABLE IF NOT EXISTS "ManagedAsset" (
  "id"               TEXT PRIMARY KEY,
  "assetType"        TEXT NOT NULL,
  "assetKey"         TEXT NOT NULL,
  "ownerId"          TEXT,
  "scope"            TEXT NOT NULL DEFAULT 'global',
  "region"           TEXT,
  "currentVersion"   INTEGER NOT NULL DEFAULT 0,
  "status"           TEXT NOT NULL DEFAULT 'active',
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ManagedAsset_assetType_assetKey_key" UNIQUE ("assetType","assetKey")
);
CREATE INDEX IF NOT EXISTS "ManagedAsset_status_idx" ON "ManagedAsset"("status");
CREATE INDEX IF NOT EXISTS "ManagedAsset_ownerId_idx" ON "ManagedAsset"("ownerId");

CREATE TABLE IF NOT EXISTS "AssetVersion" (
  "id"         TEXT PRIMARY KEY,
  "assetKey"   TEXT NOT NULL,
  "version"    INTEGER NOT NULL,
  "contentRef" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "content"    TEXT,
  "status"     TEXT NOT NULL DEFAULT 'quarantined',
  "createdBy"  TEXT NOT NULL,
  "actorKind"  TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssetVersion_assetKey_version_key" UNIQUE ("assetKey","version")
);
CREATE INDEX IF NOT EXISTS "AssetVersion_assetKey_status_idx" ON "AssetVersion"("assetKey","status");

CREATE TABLE IF NOT EXISTS "ChangeRequest" (
  "id"             TEXT PRIMARY KEY,
  "assetId"        TEXT NOT NULL,
  "assetKey"       TEXT NOT NULL,
  "fromVersion"    INTEGER NOT NULL,
  "toVersion"      INTEGER NOT NULL,
  "proposal"       TEXT NOT NULL,
  "hypothesis"     TEXT NOT NULL,
  "evidenceRefs"   TEXT,
  "riskLevel"      TEXT NOT NULL DEFAULT 'r1',
  "gateLevel"      INTEGER NOT NULL DEFAULT 1,
  "proposedBy"     TEXT NOT NULL,
  "proposerKind"   TEXT NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "baselineId"     TEXT,
  "rolloutId"      TEXT,
  "canaryPercent"  INTEGER NOT NULL DEFAULT 0,
  "evaluationJson" TEXT,
  "decidedBy"      TEXT,
  "decidedAt"      TIMESTAMP(3),
  "rejectReason"   TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ChangeRequest_status_createdAt_idx" ON "ChangeRequest"("status","createdAt");
CREATE INDEX IF NOT EXISTS "ChangeRequest_assetKey_status_idx" ON "ChangeRequest"("assetKey","status");
CREATE INDEX IF NOT EXISTS "ChangeRequest_riskLevel_status_idx" ON "ChangeRequest"("riskLevel","status");

CREATE TABLE IF NOT EXISTS "SystemPause" (
  "id"         TEXT PRIMARY KEY,
  "scope"      TEXT NOT NULL,
  "resource"   TEXT NOT NULL,
  "level"      TEXT NOT NULL DEFAULT 'write',
  "pausedBy"   TEXT NOT NULL,
  "reason"     TEXT NOT NULL,
  "expiresAt"  TIMESTAMP(3),
  "resumedAt"  TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "SystemPause_scope_resource_idx" ON "SystemPause"("scope","resource");
CREATE INDEX IF NOT EXISTS "SystemPause_expiresAt_idx" ON "SystemPause"("expiresAt");
