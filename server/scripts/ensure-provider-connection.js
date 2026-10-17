// One-off: create the ProviderConnection table in the user DB if missing.
const { PrismaClient } = require('@prisma/client-user');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const url = process.env.DATABASE_URL_USER;
if (!url) { console.error('DATABASE_URL_USER missing'); process.exit(1); }

const prisma = new PrismaClient({ datasources: { db: { url } } });

(async () => {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ProviderConnection" (
      "provider" TEXT NOT NULL,
      "label" TEXT NOT NULL DEFAULT '',
      "baseUrl" TEXT NOT NULL,
      "baseUrlRoot" TEXT,
      "apiKeys" TEXT NOT NULL DEFAULT '[]',
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("provider")
    );
  `);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT provider, label, "baseUrl", enabled FROM "ProviderConnection" ORDER BY provider`,
  );
  console.log('ProviderConnection table ready. rows:', JSON.stringify(rows));
  await prisma.$disconnect();
})().catch((e) => { console.error('DDL failed:', e.message); process.exit(1); });
