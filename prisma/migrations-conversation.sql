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

