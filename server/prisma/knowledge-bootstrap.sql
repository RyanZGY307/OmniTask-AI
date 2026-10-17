-- Knowledge base bootstrap (11 tables)
-- Execute against the DATABASE_URL_KNOWLEDGE database, e.g.:
--   psql "$DATABASE_URL_KNOWLEDGE" -f knowledge-bootstrap.sql
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS "KnowledgeFolder" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "KnowledgeBase" (
  "id" TEXT PRIMARY KEY,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "evidenceLevel" TEXT NOT NULL DEFAULT 'C',
  "region" TEXT,
  "product" TEXT,
  "version" TEXT,
  "source" TEXT,
  "folderId" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeBase_folderId_fkey"
    FOREIGN KEY ("folderId") REFERENCES "KnowledgeFolder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "DocumentChunk" (
  "id" TEXT PRIMARY KEY,
  "sourceId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "userId" TEXT,
  "content" TEXT NOT NULL,
  "title" TEXT,
  "language" TEXT,
  "metadata" JSONB,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "DocumentChunk_sourceType_sourceId_idx" ON "DocumentChunk" ("sourceType", "sourceId");
CREATE INDEX IF NOT EXISTS "DocumentChunk_userId_idx" ON "DocumentChunk" ("userId");
CREATE INDEX IF NOT EXISTS "DocumentChunk_isActive_idx" ON "DocumentChunk" ("isActive");

CREATE TABLE IF NOT EXISTS "Skill" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "prompt" TEXT NOT NULL,
  "category" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "LegalRule" (
  "id" TEXT PRIMARY KEY,
  "region" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "category" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "EvolutionSignal" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT,
  "conversationId" TEXT,
  "messageId" TEXT,
  "region" TEXT,
  "signalType" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'low',
  "detail" TEXT,
  "attributed" BOOLEAN NOT NULL DEFAULT false,
  "worthEvolving" BOOLEAN NOT NULL DEFAULT false,
  "attribution" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "EvolutionSignal_signalType_createdAt_idx" ON "EvolutionSignal" ("signalType", "createdAt");
CREATE INDEX IF NOT EXISTS "EvolutionSignal_userId_idx" ON "EvolutionSignal" ("userId");
CREATE INDEX IF NOT EXISTS "EvolutionSignal_region_idx" ON "EvolutionSignal" ("region");

CREATE TABLE IF NOT EXISTS "EvolutionCandidate" (
  "id" TEXT PRIMARY KEY,
  "scope" TEXT NOT NULL,
  "changeType" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "hypothesis" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "evidenceRefs" JSONB,
  "region" TEXT,
  "userId" TEXT,
  "blastRadius" TEXT NOT NULL DEFAULT 'low',
  "gateLevel" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "evaluationId" TEXT,
  "promotedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "rejectReason" TEXT,
  "canaryPercent" INTEGER NOT NULL DEFAULT 0,
  "createdBy" TEXT NOT NULL DEFAULT 'evolution-engine',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "EvolutionCandidate_scope_status_idx" ON "EvolutionCandidate" ("scope", "status");
CREATE INDEX IF NOT EXISTS "EvolutionCandidate_gateLevel_status_idx" ON "EvolutionCandidate" ("gateLevel", "status");
CREATE INDEX IF NOT EXISTS "EvolutionCandidate_region_idx" ON "EvolutionCandidate" ("region");
CREATE INDEX IF NOT EXISTS "EvolutionCandidate_status_createdAt_idx" ON "EvolutionCandidate" ("status", "createdAt");

CREATE TABLE IF NOT EXISTS "EvaluationReport" (
  "id" TEXT PRIMARY KEY,
  "candidateId" TEXT NOT NULL,
  "securityPassed" BOOLEAN NOT NULL DEFAULT false,
  "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "regressionPassed" INTEGER NOT NULL DEFAULT 0,
  "regressionFailed" INTEGER NOT NULL DEFAULT 0,
  "agnesAssessment" TEXT,
  "decision" TEXT NOT NULL DEFAULT 'pending',
  "metrics" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "EvaluationReport_candidateId_idx" ON "EvaluationReport" ("candidateId");

CREATE TABLE IF NOT EXISTS "RegionInsight" (
  "id" TEXT PRIMARY KEY,
  "region" TEXT NOT NULL,
  "insight" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  "candidateId" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "hitCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "RegionInsight_region_idx" ON "RegionInsight" ("region");

CREATE TABLE IF NOT EXISTS "EvolutionAudit" (
  "id" TEXT PRIMARY KEY,
  "action" TEXT NOT NULL,
  "candidateId" TEXT,
  "adminId" TEXT,
  "scope" TEXT,
  "reason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "EvolutionAudit_action_createdAt_idx" ON "EvolutionAudit" ("action", "createdAt");

CREATE TABLE IF NOT EXISTS "EvolutionBudget" (
  "id" TEXT PRIMARY KEY,
  "date" TIMESTAMP(3) NOT NULL UNIQUE,
  "systemPoolTotal" INTEGER NOT NULL DEFAULT 10000,
  "systemPoolUsed" INTEGER NOT NULL DEFAULT 0,
  "signalCount" INTEGER NOT NULL DEFAULT 0,
  "candidateCount" INTEGER NOT NULL DEFAULT 0,
  "promoteCount" INTEGER NOT NULL DEFAULT 0,
  "rejectCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
