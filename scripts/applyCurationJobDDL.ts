// 一次性脚本：把 CurationJob 建表 DDL 应用到 user 库（幂等，可重复执行）。
// 运行：npx tsx scripts/applyCurationJobDDL.ts
import { prisma, wakeDatabase } from '../src/services/db';

const DDL = `
CREATE TABLE IF NOT EXISTS "CurationJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'analyzed',
    "trigger" TEXT NOT NULL DEFAULT 'auto',
    "opsJson" TEXT NOT NULL DEFAULT '[]',
    "appliedJson" TEXT NOT NULL DEFAULT '[]',
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "CurationJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CurationJob_dedupeKey_key" ON "CurationJob"("dedupeKey");
CREATE INDEX IF NOT EXISTS "CurationJob_userId_createdAt_idx" ON "CurationJob"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "CurationJob_status_idx" ON "CurationJob"("status");
`;

async function main() {
  // Layerbase 有休眠机制：先唤醒再执行（项目惯例）
  const ok = await wakeDatabase(6);
  if (!ok) { console.error('[CurationJob DDL] user 库唤醒失败'); process.exit(1); }
  const statements = DDL.split(';').map((s) => s.trim()).filter(Boolean);
  // 附带上次会话尚未执行的 User.gender 列（幂等）
  statements.push('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "gender" TEXT');
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
    console.log('OK:', stmt.split('\n')[0].slice(0, 60));
  }
  await prisma.$disconnect();
}
main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
