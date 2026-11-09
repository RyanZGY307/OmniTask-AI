-- RSI 任务队列表（与 researchJob/evolutionJob 同库同模式）
-- 目标库：user
CREATE TABLE IF NOT EXISTS "RsiJob" (
  "id"           TEXT PRIMARY KEY,
  "kind"         TEXT NOT NULL DEFAULT 'rsi_run',
  "payload"      TEXT,
  "priority"     INTEGER NOT NULL DEFAULT 5,
  "status"       TEXT NOT NULL DEFAULT 'QUEUED',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "workerId"     TEXT,
  "lastError"    TEXT,
  "resultJson"   TEXT,
  "heartbeatAt"  TIMESTAMP(3),
  "leaseUntil"   TIMESTAMP(3),
  "queuedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"    TIMESTAMP(3),
  "completedAt"  TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "RsiJob_status_queuedAt_idx" ON "RsiJob"("status","queuedAt");
CREATE INDEX IF NOT EXISTS "RsiJob_status_priority_idx" ON "RsiJob"("status","priority");
CREATE INDEX IF NOT EXISTS "RsiJob_workerId_heartbeatAt_idx" ON "RsiJob"("workerId","heartbeatAt");
CREATE INDEX IF NOT EXISTS "RsiJob_leaseUntil_idx" ON "RsiJob"("leaseUntil");
