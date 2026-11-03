-- OmniTask-Agent M0 初始化迁移（幂等范式对齐宿主 applyMigrations.js）
-- 应用方式：宿主 scripts/applyMigrations.js（CREATE TABLE IF NOT EXISTS + 逐语句回退）
-- 注意：conversationId/userId 为软引用——跨 schema 外键规范待宿主确认（原 Q4），本迁移不加 FK
-- 回滚：DROP TABLE IF EXISTS（新表无历史数据依赖）；幂等重放安全

CREATE TABLE IF NOT EXISTS "Task" (
  "id"              TEXT PRIMARY KEY,
  "conversationId"  TEXT,
  "userId"          TEXT NOT NULL,
  "projectId"       TEXT,
  "title"           TEXT NOT NULL,
  "objective"       TEXT NOT NULL,
  "state"           TEXT NOT NULL DEFAULT 'queued',
  "depth"           TEXT NOT NULL DEFAULT 'd2',
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Task_conversationId_state_idx" ON "Task"("conversationId","state");

CREATE TABLE IF NOT EXISTS "Run" (
  "id"            TEXT PRIMARY KEY,
  "taskId"        TEXT NOT NULL,
  "state"         TEXT NOT NULL DEFAULT 'created',
  "modelTier"     TEXT NOT NULL DEFAULT 'standard',
  "budget"        JSONB,
  "checkpointId"  TEXT,
  "resumedFrom"   TEXT,
  "depth"         TEXT NOT NULL DEFAULT 'd2',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Run_taskId_state_idx" ON "Run"("taskId","state");

CREATE TABLE IF NOT EXISTS "Step" (
  "id"          TEXT PRIMARY KEY,
  "runId"       TEXT NOT NULL,
  "seq"         INTEGER NOT NULL,
  "kind"        TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "state"       TEXT NOT NULL DEFAULT 'pending',
  "toolCallId"  TEXT,
  "waitingOn"   TEXT,
  "errorKind"   TEXT,
  "startedAt"   TIMESTAMP(3),
  "finishedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Step_runId_seq_key" UNIQUE ("runId","seq")
);
CREATE INDEX IF NOT EXISTS "Step_runId_state_idx" ON "Step"("runId","state");

CREATE TABLE IF NOT EXISTS "ToolCall" (
  "id"              TEXT PRIMARY KEY,
  "stepId"          TEXT,
  "runId"           TEXT NOT NULL,
  "toolId"          TEXT NOT NULL,
  "toolVersion"     TEXT NOT NULL,
  "argsJson"        JSONB NOT NULL,
  "state"           TEXT NOT NULL DEFAULT 'pending',
  "approvalId"      TEXT,
  "idempotencyKey"  TEXT NOT NULL,
  "attempt"         INTEGER NOT NULL DEFAULT 0,
  "resultJson"      JSONB,
  "errorKind"       TEXT,
  "durationMs"      INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ToolCall_runId_state_idx" ON "ToolCall"("runId","state");
CREATE INDEX IF NOT EXISTS "ToolCall_idempotencyKey_idx" ON "ToolCall"("idempotencyKey");

CREATE TABLE IF NOT EXISTS "ModelCall" (
  "id"                  TEXT PRIMARY KEY,
  "runId"               TEXT NOT NULL,
  "stepId"              TEXT,
  "role"                TEXT NOT NULL,
  "modelKey"            TEXT NOT NULL,
  "provider"            TEXT NOT NULL,
  "usageProvider"       JSONB,
  "usageNormalized"     JSONB,
  "capabilitySnapshot"  JSONB NOT NULL,
  "modelConfigSnapshot" JSONB NOT NULL,
  "finishReason"        TEXT NOT NULL,
  "latencyMs"           INTEGER NOT NULL,
  "degraded"            JSONB,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ModelCall_runId_role_idx" ON "ModelCall"("runId","role");

CREATE TABLE IF NOT EXISTS "Event" (
  "id"      TEXT PRIMARY KEY,
  "runId"   TEXT NOT NULL,
  "seq"     INTEGER NOT NULL,
  "type"    TEXT NOT NULL,
  "level"   TEXT NOT NULL DEFAULT 'info',
  "payload" JSONB NOT NULL,
  "ts"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Event_runId_seq_key" UNIQUE ("runId","seq")
);
CREATE INDEX IF NOT EXISTS "Event_runId_ts_idx" ON "Event"("runId","ts");

CREATE TABLE IF NOT EXISTS "Checkpoint" (
  "id"        TEXT PRIMARY KEY,
  "runId"     TEXT NOT NULL,
  "version"   INTEGER NOT NULL,
  "atEventSeq" INTEGER NOT NULL,
  "stateJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Checkpoint_runId_version_key" UNIQUE ("runId","version")
);

CREATE TABLE IF NOT EXISTS "Approval" (
  "id"              TEXT PRIMARY KEY,
  "runId"           TEXT NOT NULL,
  "stepId"          TEXT,
  "conversationId"  TEXT,
  "toolFingerprint" TEXT NOT NULL,
  "riskLevel"       TEXT NOT NULL,
  "summary"         TEXT NOT NULL,
  "state"           TEXT NOT NULL DEFAULT 'pending',
  "decisionBy"      TEXT,
  "decidedAt"       TIMESTAMP(3),
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Approval_state_expiresAt_idx" ON "Approval"("state","expiresAt");

CREATE TABLE IF NOT EXISTS "UserInputRequest" (
  "id"             TEXT PRIMARY KEY,
  "runId"          TEXT NOT NULL,
  "stepId"         TEXT,
  "conversationId" TEXT,
  "kind"           TEXT NOT NULL,
  "prompt"         TEXT NOT NULL,
  "options"        JSONB,
  "allowCustom"    BOOLEAN NOT NULL DEFAULT true,
  "answer"         JSONB,
  "state"          TEXT NOT NULL DEFAULT 'pending',
  "expiresAt"      TIMESTAMP(3),
  "answeredAt"     TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "UserInputRequest_state_expiresAt_idx" ON "UserInputRequest"("state","expiresAt");

CREATE TABLE IF NOT EXISTS "PermissionRule" (
  "id"         TEXT PRIMARY KEY,
  "scope"      TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "projectId"  TEXT,
  "program"    TEXT NOT NULL,
  "subcommand" TEXT,
  "kind"       TEXT NOT NULL,
  "source"     TEXT NOT NULL,
  "enabled"    BOOLEAN NOT NULL DEFAULT true,
  "expiresAt"  TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PermissionRule_userId_scope_program_subcommand_kind_key" UNIQUE ("userId","scope","program","subcommand","kind")
);

CREATE TABLE IF NOT EXISTS "Todo" (
  "id"        TEXT PRIMARY KEY,
  "runId"     TEXT NOT NULL,
  "seq"       INTEGER NOT NULL,
  "title"     TEXT NOT NULL,
  "status"    TEXT NOT NULL DEFAULT 'pending',
  "blockedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Todo_runId_seq_key" UNIQUE ("runId","seq")
);

CREATE TABLE IF NOT EXISTS "Artifact" (
  "id"        TEXT PRIMARY KEY,
  "taskId"    TEXT NOT NULL,
  "kind"      TEXT NOT NULL,
  "title"     TEXT NOT NULL,
  "uri"       TEXT NOT NULL,
  "storageRef" TEXT,
  "stepId"    TEXT,
  "version"   INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Artifact_taskId_idx" ON "Artifact"("taskId");
