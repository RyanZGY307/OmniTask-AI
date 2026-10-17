-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "OverflowRow" (
    "id" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "sourceDb" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverflowRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OverflowAudit" (
    "id" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "sourceDb" TEXT NOT NULL,
    "targetDb" TEXT NOT NULL DEFAULT 'overflow',
    "reason" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverflowAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OverflowRow_sourceTable_sourceDb_idx" ON "OverflowRow"("sourceTable", "sourceDb");

-- CreateIndex
CREATE INDEX "OverflowRow_userId_idx" ON "OverflowRow"("userId");

-- CreateIndex
CREATE INDEX "OverflowAudit_sourceDb_sourceTable_idx" ON "OverflowAudit"("sourceDb", "sourceTable");

