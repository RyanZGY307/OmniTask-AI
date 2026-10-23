-- ================================================================
-- 系统观测中心 — 手写迁移（项目现行机制：applyMigrations.js）
-- 对应 prisma/schema-user.prisma 末尾 5 个 model。
-- 时间列统一 timestamptz（UTC）。AiRunSummary.expiresAt = createdAt + 24h。
-- 幂等：CREATE TABLE IF NOT EXISTS + 索引 IF NOT EXISTS。
-- ================================================================

CREATE TABLE IF NOT EXISTS "DbMetricSnapshot" (
  "id"                          TEXT PRIMARY KEY,
  "capturedAt"                  TIMESTAMPTZ NOT NULL,
  "domain"                      TEXT NOT NULL,
  "dbName"                      TEXT NOT NULL,
  "connectionStatus"            TEXT NOT NULL DEFAULT 'unknown',
  "sizeBytes"                   BIGINT,
  "schemaCount"                 INTEGER,
  "tableCount"                  INTEGER,
  "instanceId"                  TEXT,
  "instanceDiskUsedBytes"       BIGINT,
  "instanceDiskTotalBytes"      BIGINT,
  "instanceDiskAvailableBytes"  BIGINT,
  "instanceSource"              TEXT NOT NULL DEFAULT 'unknown',
  "growthBytes24h"              BIGINT,
  "latencyMs"                   INTEGER,
  "errorCode"                   TEXT,
  "createdAt"                   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "DbMetricSnapshot_domain_capturedAt_idx" ON "DbMetricSnapshot" ("domain", "capturedAt");
CREATE INDEX IF NOT EXISTS "DbMetricSnapshot_capturedAt_idx"     ON "DbMetricSnapshot" ("capturedAt");

CREATE TABLE IF NOT EXISTS "DbStorageEntry" (
  "id"               TEXT PRIMARY KEY,
  "captureId"        TEXT NOT NULL,
  "capturedAt"       TIMESTAMPTZ NOT NULL,
  "domain"           TEXT NOT NULL,
  "dbName"           TEXT NOT NULL,
  "schemaName"       TEXT NOT NULL,
  "tableName"        TEXT NOT NULL,
  "objectKind"       TEXT NOT NULL,
  "sizeBytes"        BIGINT NOT NULL,
  "rowEstimate"      BIGINT,
  "businessCategory" TEXT NOT NULL DEFAULT 'unclassified',
  "categoryConfidence" TEXT NOT NULL DEFAULT 'unknown',
  "categoryEvidence" TEXT,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "DbStorageEntry_captureId_idx"       ON "DbStorageEntry" ("captureId");
CREATE INDEX IF NOT EXISTS "DbStorageEntry_capturedAt_idx"      ON "DbStorageEntry" ("capturedAt");
CREATE INDEX IF NOT EXISTS "DbStorageEntry_businessCategory_idx" ON "DbStorageEntry" ("businessCategory");
CREATE INDEX IF NOT EXISTS "DbStorageEntry_domain_capturedAt_idx" ON "DbStorageEntry" ("domain", "capturedAt");

CREATE TABLE IF NOT EXISTS "AiRunSummary" (
  "id"               TEXT PRIMARY KEY,
  "taskId"           TEXT NOT NULL,
  "taskKind"         TEXT NOT NULL,
  "createdAt"        TIMESTAMPTZ NOT NULL,
  "expiresAt"        TIMESTAMPTZ NOT NULL,
  "summary"          TEXT NOT NULL,
  "triggerSource"    TEXT NOT NULL DEFAULT 'unknown',
  "agentName"        TEXT,
  "modelUsed"        TEXT,
  "goal"             TEXT,
  "status"           TEXT NOT NULL DEFAULT 'unknown',
  "decisionJson"     TEXT,
  "guardJson"        TEXT,
  "toolsJson"        TEXT,
  "outcomeJson"      TEXT,
  "startedAt"        TIMESTAMPTZ,
  "completedAt"      TIMESTAMPTZ,
  "redactionApplied" TEXT NOT NULL DEFAULT '',
  "createdAtRow"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "AiRunSummary_taskId_taskKind_key" UNIQUE ("taskId", "taskKind")
);
CREATE INDEX IF NOT EXISTS "AiRunSummary_expiresAt_idx"          ON "AiRunSummary" ("expiresAt");
CREATE INDEX IF NOT EXISTS "AiRunSummary_taskKind_createdAt_idx" ON "AiRunSummary" ("taskKind", "createdAt");

CREATE TABLE IF NOT EXISTS "ObsEvent" (
  "id"         TEXT PRIMARY KEY,
  "ts"         TIMESTAMPTZ NOT NULL,
  "kind"       TEXT NOT NULL,
  "severity"   TEXT NOT NULL DEFAULT 'info',
  "title"      TEXT NOT NULL,
  "detail"     TEXT NOT NULL DEFAULT '',
  "taskId"     TEXT,
  "taskKind"   TEXT,
  "domain"     TEXT,
  "status"     TEXT NOT NULL DEFAULT 'open',
  "resolved"   BOOLEAN NOT NULL DEFAULT false,
  "payloadRef" TEXT,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ObsEvent_ts_idx"           ON "ObsEvent" ("ts");
CREATE INDEX IF NOT EXISTS "ObsEvent_severity_ts_idx"  ON "ObsEvent" ("severity", "ts");
CREATE INDEX IF NOT EXISTS "ObsEvent_kind_ts_idx"      ON "ObsEvent" ("kind", "ts");

CREATE TABLE IF NOT EXISTS "SummaryPurgeLog" (
  "id"            TEXT PRIMARY KEY,
  "startedAt"     TIMESTAMPTZ NOT NULL,
  "finishedAt"    TIMESTAMPTZ NOT NULL,
  "mode"          TEXT NOT NULL DEFAULT 'periodic',
  "scannedCount"  INTEGER NOT NULL DEFAULT 0,
  "expiredFound"  INTEGER NOT NULL DEFAULT 0,
  "deletedCount"  INTEGER NOT NULL DEFAULT 0,
  "failedCount"   INTEGER NOT NULL DEFAULT 0,
  "latencyMs"     INTEGER NOT NULL DEFAULT 0,
  "leaseAcquired" BOOLEAN NOT NULL DEFAULT false,
  "errorMessage"  TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "SummaryPurgeLog_startedAt_idx" ON "SummaryPurgeLog" ("startedAt");
