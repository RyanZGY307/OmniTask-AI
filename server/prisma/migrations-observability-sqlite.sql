-- ================================================================
-- 系统观测中心 — SQLite 版建表 DDL
-- 用途：把低频数据（观测指标/存储明细/事件/清理日志）落到 SQLite。
-- 依据：dbAdapter/spec.ts 的 DOMAIN_PLACEMENT 把 observability 标为 low
--       frequency → SQLite（并发写入弱于 PG，高频数据不放这里）。
--
-- 与 PG 版的**关键差异**（不是照抄，是三类真实约束）：
--
--  1) 时间列：PG 用 TIMESTAMPTZ，SQLite 没有该类型。
--     统一存 **ISO-8601 UTC 字符串**（'YYYY-MM-DDTHH:MM:SS.sssZ'）。
--     理由：该格式的字典序 == 时间顺序，因此索引仍可用于范围查询与
--     ORDER BY；且 new Date(str) 可直接反解析。不用 unix ms 整数是因为
--     那样 any[] 比较与可读性都变差，调试/手查困难。
--
--  2) 字节数列：PG 用 BIGINT，SQLite INTEGER 是 64 位，但 **JS number
--     超过 2^53 就丢精度**（观测里单库/TOAST 完全可能到 TB 级 = 1.6e13，
--     尚在安全区；实例级累加与 long-tail 场景可能越界）。
--     因此 sizeBytes / instanceDisk* / growthBytes24h / rowEstimate
--     一律用 **TEXT 存十进制整数字符串**，读回时按需 toJsonNumber()。
--     这不是洁癖：pgStats.toJsonNumber 已处理「超大 BigInt → 字符串」，
--     写入侧保持同一种表示，整个链路才不会在 SQLite 边界悄悄丢位。
--
--  3) BOOLEAN：SQLite 无布尔类型，用 INTEGER 0/1。PG 版的
--     leaseAcquired / resolved 在此译为 NOT NULL DEFAULT 0。
--
-- 并发说明（如实记录）：已开 WAL + busy_timeout，但 SQLite 仍是
-- **单写多读**，并发写入会串行化。这正是观测数据放 SQLite 的前提——
-- 它由单个后台采集器写、管理页低频读，不构成争用。
--
-- 状态：本文件只是 DDL。**尚未有代码把观测数据写到 SQLite** ——
-- collector.ts 目前仍写 PostgreSQL（prisma.dbMetricSnapshot）。
-- 落地需要第二步：在 collector/purge 中按 dbAdapter 判定选择目标库。
-- ================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS "DbMetricSnapshot" (
  "id"                          TEXT PRIMARY KEY,
  "capturedAt"                  TEXT NOT NULL,          -- ISO-8601 UTC
  "domain"                      TEXT NOT NULL,
  "dbName"                      TEXT NOT NULL,
  "connectionStatus"            TEXT NOT NULL DEFAULT 'unknown',
  "sizeBytes"                   TEXT,                   -- 十进制整数字符串
  "schemaCount"                 INTEGER,
  "tableCount"                  INTEGER,
  "instanceId"                  TEXT,
  "instanceDiskUsedBytes"       TEXT,
  "instanceDiskTotalBytes"      TEXT,
  "instanceDiskAvailableBytes"  TEXT,
  "instanceSource"              TEXT NOT NULL DEFAULT 'unknown',
  "growthBytes24h"              TEXT,
  "latencyMs"                   INTEGER,
  "errorCode"                   TEXT,
  "createdAt"                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS "DbMetricSnapshot_domain_capturedAt_idx" ON "DbMetricSnapshot" ("domain", "capturedAt");
CREATE INDEX IF NOT EXISTS "DbMetricSnapshot_capturedAt_idx"        ON "DbMetricSnapshot" ("capturedAt");

CREATE TABLE IF NOT EXISTS "DbStorageEntry" (
  "id"               TEXT PRIMARY KEY,
  "captureId"        TEXT NOT NULL,
  "capturedAt"       TEXT NOT NULL,
  "domain"           TEXT NOT NULL,
  "dbName"           TEXT NOT NULL,
  "schemaName"       TEXT NOT NULL,
  "tableName"        TEXT NOT NULL,
  "objectKind"       TEXT NOT NULL,                     -- table | index | toast
  "sizeBytes"        TEXT NOT NULL,                     -- 十进制整数字符串
  "rowEstimate"      TEXT,
  "businessCategory" TEXT NOT NULL DEFAULT 'unclassified',
  "categoryConfidence" TEXT NOT NULL DEFAULT 'unknown',
  "categoryEvidence" TEXT,
  "createdAt"        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS "DbStorageEntry_captureId_idx"         ON "DbStorageEntry" ("captureId");
CREATE INDEX IF NOT EXISTS "DbStorageEntry_capturedAt_idx"        ON "DbStorageEntry" ("capturedAt");
CREATE INDEX IF NOT EXISTS "DbStorageEntry_businessCategory_idx" ON "DbStorageEntry" ("businessCategory");
CREATE INDEX IF NOT EXISTS "DbStorageEntry_domain_capturedAt_idx" ON "DbStorageEntry" ("domain", "capturedAt");

-- 24h 强制保留：expiresAt 索引是清理任务的唯一依据，不可省。
CREATE TABLE IF NOT EXISTS "AiRunSummary" (
  "id"               TEXT PRIMARY KEY,
  "taskId"           TEXT NOT NULL,
  "taskKind"         TEXT NOT NULL,
  "createdAt"        TEXT NOT NULL,                     -- 任务开始时刻（锚点）
  "expiresAt"        TEXT NOT NULL,                     -- = createdAt + 24h
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
  "startedAt"        TEXT,
  "completedAt"      TEXT,
  "redactionApplied" TEXT NOT NULL DEFAULT '',
  "createdAtRow"     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE ("taskId", "taskKind")
);
CREATE INDEX IF NOT EXISTS "AiRunSummary_expiresAt_idx"         ON "AiRunSummary" ("expiresAt");
CREATE INDEX IF NOT EXISTS "AiRunSummary_taskKind_createdAt_idx" ON "AiRunSummary" ("taskKind", "createdAt");

CREATE TABLE IF NOT EXISTS "ObsEvent" (
  "id"         TEXT PRIMARY KEY,
  "ts"         TEXT NOT NULL,
  "kind"       TEXT NOT NULL,
  "severity"   TEXT NOT NULL DEFAULT 'info',
  "title"      TEXT NOT NULL,
  "detail"     TEXT NOT NULL DEFAULT '',
  "taskId"     TEXT,
  "taskKind"   TEXT,
  "domain"     TEXT,
  "status"     TEXT NOT NULL DEFAULT 'open',
  "resolved"   INTEGER NOT NULL DEFAULT 0,              -- 0/1
  "payloadRef" TEXT,
  "createdAt"  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS "ObsEvent_ts_idx"          ON "ObsEvent" ("ts");
CREATE INDEX IF NOT EXISTS "ObsEvent_severity_ts_idx" ON "ObsEvent" ("severity", "ts");
CREATE INDEX IF NOT EXISTS "ObsEvent_kind_ts_idx"     ON "ObsEvent" ("kind", "ts");

CREATE TABLE IF NOT EXISTS "SummaryPurgeLog" (
  "id"            TEXT PRIMARY KEY,
  "startedAt"     TEXT NOT NULL,
  "finishedAt"    TEXT NOT NULL,
  "mode"          TEXT NOT NULL DEFAULT 'periodic',
  "scannedCount"  INTEGER NOT NULL DEFAULT 0,
  "expiredFound"  INTEGER NOT NULL DEFAULT 0,
  "deletedCount"  INTEGER NOT NULL DEFAULT 0,
  "failedCount"   INTEGER NOT NULL DEFAULT 0,
  "latencyMs"     INTEGER NOT NULL DEFAULT 0,
  "leaseAcquired" INTEGER NOT NULL DEFAULT 0,           -- 0/1
  "errorMessage"  TEXT,
  "createdAt"     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS "SummaryPurgeLog_startedAt_idx" ON "SummaryPurgeLog" ("startedAt");
