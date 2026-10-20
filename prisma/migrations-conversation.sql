-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '新对话',
    "userId" TEXT NOT NULL,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "messageType" TEXT NOT NULL DEFAULT 'text',
    "model" TEXT,
    "mode" TEXT,
    "metadata" TEXT,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "creditsCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Safety flags (2026-10-12): conversation warning counter + flagged snapshot store
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "safetyWarnings" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "isSafetyFlagged" BOOLEAN NOT NULL DEFAULT false;
-- 受限事项历史（敏感度警告按“同一受限事项”累计）
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "safetyTopicHistory" TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS "FlaggedConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL DEFAULT '',
    "conversationId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "reason" TEXT,
    "model" TEXT,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedPairs" INTEGER NOT NULL DEFAULT 0,
    "messagesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlaggedConversation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FlaggedConversation_userId_createdAt_idx" ON "FlaggedConversation"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "FlaggedConversation_conversationId_idx" ON "FlaggedConversation"("conversationId");

-- ============================================================
-- 敏感标记落档增强（2026-10）：幂等键 / 标签 / 提交状态 / 保留期
-- 对已存在的库执行；新库由上面的建表语句直接包含这些列。
-- ============================================================
ALTER TABLE "FlaggedConversation" ADD COLUMN IF NOT EXISTS "sourceMessageId" TEXT;
ALTER TABLE "FlaggedConversation" ADD COLUMN IF NOT EXISTS "topics" TEXT;
ALTER TABLE "FlaggedConversation" ADD COLUMN IF NOT EXISTS "uploadStatus" TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE "FlaggedConversation" ADD COLUMN IF NOT EXISTS "retentionUntil" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "FlaggedConversation_sourceMessageId_key" ON "FlaggedConversation"("sourceMessageId");
CREATE INDEX IF NOT EXISTS "FlaggedConversation_retentionUntil_idx" ON "FlaggedConversation"("retentionUntil");


-- File workspace (2026-10-18): turn chat output into readable/editable files.
-- Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS "WorkspaceFile" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'txt',
    "source" TEXT NOT NULL DEFAULT 'extracted',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceFile_conversationId_path_key" ON "WorkspaceFile"("conversationId", "path");
CREATE INDEX IF NOT EXISTS "WorkspaceFile_conversationId_idx" ON "WorkspaceFile"("conversationId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkspaceFile_conversationId_fkey') THEN
    ALTER TABLE "WorkspaceFile" ADD CONSTRAINT "WorkspaceFile_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ================================================================
-- 对话记忆管理系统（context compression）— 2026-10-20
--
-- 1. Message.seq：单调递增的对话内序号。
--    审计发现 Message 原无稳定序号（只有 createdAt 与 cuid，cuid 非单调），
--    而压缩截止位置与"不误删新消息"都必须依据可靠序号，故新增并回填。
-- 2. ConversationSummary：每对话当前已提交的累积摘要（版本化）。
-- 3. ContextCompressionTask：压缩任务（含冻结范围、基版本、状态机）。
-- 4. CompressionSegment：分段压缩的中间结果（可恢复、幂等）。
--
-- 全部为幂等 DDL：可重复执行。
-- ================================================================

-- 1) Message.seq — 单调序号，压缩边界与删除边界的事实依据
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "seq" INTEGER;

-- 回填：按 createdAt 排序为每个对话的既有消息赋 1..N（幂等：
-- 已有序号的行不动，只填 NULL 的）。
WITH ordered AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "conversationId" ORDER BY "createdAt" ASC, "id" ASC) AS rn
  FROM "Message"
  WHERE "seq" IS NULL
)
UPDATE "Message" m
SET "seq" = o.rn
FROM ordered o
WHERE m.id = o.id AND m.seq IS NULL;

-- 后续新消息由服务端用「当前 max+1」分配（见 memoryManager/seq.ts），
-- 这里不依赖 Postgres 序列，避免多进程/多实例下序列与租户边界冲突。

-- 索引：按对话取序号范围（压缩取前缀、保留后缀都走此索引）
CREATE INDEX IF NOT EXISTS "Message_conversationId_seq_idx" ON "Message"("conversationId", "seq");

-- 2) ConversationSummary — 每对话的当前累积摘要（可版本化）
CREATE TABLE IF NOT EXISTS "ConversationSummary" (
    "id"                TEXT NOT NULL,
    "conversationId"    TEXT NOT NULL,
    "userId"            TEXT NOT NULL,
    -- 摘要正文（结构化压缩指令的产物，含 coverage 元数据）
    "content"           TEXT NOT NULL,
    -- 摘要覆盖到的最大 seq（含）；此后的消息属于"未被摘要覆盖的原始历史"
    "coveredToSeq"      INTEGER NOT NULL DEFAULT 0,
    -- 摘要版本：每次提交 +1，作为乐观并发的基础
    "version"           INTEGER NOT NULL DEFAULT 1,
    -- 生成该摘要所用的模型标识（用户当前选择，不得后台私换）
    "modelId"           TEXT,
    -- 摘要表示的历史起点（通常为 1）
    "coveredFromSeq"    INTEGER NOT NULL DEFAULT 1,
    -- 结构化字段（JSON）：conversation_goal / decisions / open_issues 等
    "structured"        TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationSummary_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ConversationSummary_conversationId_key" ON "ConversationSummary"("conversationId");
CREATE INDEX IF NOT EXISTS "ConversationSummary_userId_idx" ON "ConversationSummary"("userId");

-- 3) ContextCompressionTask — 压缩任务状态机
--    对应任务书的并发安全要求：固定 source_end_seq 冻结范围、
--    base_summary_version 作乐观锁、失败保留原文。
CREATE TABLE IF NOT EXISTS "ContextCompressionTask" (
    "id"                TEXT NOT NULL,
    "conversationId"    TEXT NOT NULL,
    "userId"            TEXT NOT NULL,
    "triggerReason"     TEXT NOT NULL,           -- storage | context_85 | manual
    "sourceStartSeq"    INTEGER NOT NULL,        -- 本次压缩范围的起点（含）
    "sourceEndSeq"      INTEGER NOT NULL,        -- 本次压缩范围的终点（含）—— 冻结后不得扩大
    "baseSummaryVersion" INTEGER NOT NULL DEFAULT 0, -- 基于哪个摘要版本合并（乐观锁）
    "status"            TEXT NOT NULL DEFAULT 'PENDING',
    -- PENDING | SEGMENTING | SEGMENT_DONE | MERGING | VERIFYING | COMMITTING
    -- | COMPLETED | FAILED | CANCELLED
    "modelId"           TEXT,                    -- 本任务使用的模型（用户当前选择）
    -- 进度与统计（可观测性；不含敏感内容）
    "segmentCount"      INTEGER NOT NULL DEFAULT 0,
    "segmentsDone"      INTEGER NOT NULL DEFAULT 0,
    "mergeLevel"        INTEGER NOT NULL DEFAULT 0,
    "inputTokens"       INTEGER NOT NULL DEFAULT 0,
    "outputTokens"      INTEGER NOT NULL DEFAULT 0,
    -- 前端展示用：是否处于活动状态（排队/执行/分段/合并/验证/提交）
    "startedAt"         TIMESTAMP(3),
    "completedAt"       TIMESTAMP(3),
    "errorDetails"      TEXT,                    -- 失败原因（不含明文聊天内容与凭证）
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextCompressionTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ContextCompressionTask_conv_status_idx" ON "ContextCompressionTask"("conversationId", "status");
CREATE INDEX IF NOT EXISTS "ContextCompressionTask_user_created_idx" ON "ContextCompressionTask"("userId", "createdAt");

-- 4) CompressionSegment — 分段中间结果
--    恢复时可复用已验证的中间结果，不必无条件重跑模型。
CREATE TABLE IF NOT EXISTS "CompressionSegment" (
    "id"                TEXT NOT NULL,
    "taskId"            TEXT NOT NULL,
    "conversationId"    TEXT NOT NULL,
    "segmentIndex"      INTEGER NOT NULL,        -- 0..N，按原始顺序
    "sourceStartSeq"    INTEGER NOT NULL,
    "sourceEndSeq"      INTEGER NOT NULL,
    -- SEGMENT SUMMARY | GROUP SUMMARY | FINAL SUMMARY —— 局部摘要不得
    -- 被误当成完整历史摘要
    "level"             TEXT NOT NULL DEFAULT 'SEGMENT',
    "parentSegmentId"   TEXT,                    -- 多级合并的父子关系
    "content"           TEXT NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'PENDING',
    -- PENDING | RUNNING | DONE | FAILED
    "modelId"           TEXT,
    "inputTokens"       INTEGER NOT NULL DEFAULT 0,
    "outputTokens"      INTEGER NOT NULL DEFAULT 0,
    "retryCount"        INTEGER NOT NULL DEFAULT 0,
    "errorDetails"      TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompressionSegment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CompressionSegment_task_index_key" ON "CompressionSegment"("taskId", "segmentIndex");
CREATE INDEX IF NOT EXISTS "CompressionSegment_task_status_idx" ON "CompressionSegment"("taskId", "status");
