import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = 'admin@cortex.ai';
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existing) {
    const passwordHash = await bcrypt.hash('CortexAdmin2024!', 12);
    await prisma.user.create({
      data: {
        email: adminEmail, username: 'admin', passwordHash,
        role: 'SUPER_ADMIN', subscriptionTier: 'ULTRA',
        region: 'CN', language: 'zh-CN', creditBalance: 999999999,
        settings: { create: { defaultModel: 'auto', defaultMode: 'standard' } },
      },
    });
    console.log('Super admin: admin@cortex.ai / CortexAdmin2024!');
  }

  const packCount = await prisma.creditPack.count();
  if (packCount === 0) {
    // Permanent-validity top-up packs (matching CREDIT_PACKS in config.ts).
    await prisma.creditPack.createMany({
      data: [
        { credits: 300, price: 1.09 },
        { credits: 600, price: 1.99 },
        { credits: 1200, price: 3.59 },
        { credits: 2400, price: 6.49 },
        { credits: 5000, price: 12.89 },
        { credits: 10000, price: 24.99 },
        { credits: 15000, price: 35.99 },
      ],
    });
    console.log('Credit packs created');
  }

  const qrCount = await prisma.paymentQRCode.count();
  if (qrCount === 0) {
    await prisma.paymentQRCode.createMany({
      data: [
        { method: 'TNG', imageUrl: '' },
        { method: 'ShopeePay', imageUrl: '' },
        { method: 'PayPal', imageUrl: '' },
        { method: 'Alipay', imageUrl: '' },
      ],
    });
  }

  // Seed SubscriptionPricing defaults (Pro is the only sellable tier;
  // the legacy ULTRA row is kept only so in-flight orders still settle).
  const subCount = await prisma.subscriptionPricing.count();
  if (subCount === 0) {
    await prisma.subscriptionPricing.createMany({
      data: [
        { tier: 'PRO', monthlyUsd: 9.9, yearlyUsd: 99, creditGrant: 3000 },
        { tier: 'ULTRA', monthlyUsd: 20, yearlyUsd: 188, creditGrant: 5000 },
      ],
    });
    console.log('SubscriptionPricing seeded');
  }

  // Seed ModelConfig with current MODEL_REGISTRY entries
  const { getDynamicModels } = await import('../src/services/configSync');
  const models = getDynamicModels();
  const modelCount = await prisma.modelConfig.count();
  if (modelCount === 0) {
    for (const [key, info] of Object.entries(models)) {
      await prisma.modelConfig.upsert({
        where: { modelKey: key },
        create: {
          modelKey: key,
          provider: info.provider,
          apiModel: info.apiModel,
          displayName: info.displayName,
          tier: info.tier,
          maxTokens: info.maxTokens,
          contextWindow: info.contextWindow,
          costPer1k: info.costPer1k,
          category: info.category,
          status: info.status,
          enabled: info.enabled,
          capabilities: info.capabilities as any[],
          supportsReasoning: info.supportsReasoning,
          supportsTools: info.supportsTools,
          supportsVision: info.supportsVision,
          supportsStreaming: info.supportsStreaming,
          supportsStructuredOutput: info.supportsStructuredOutput,
          qualityProfile: info.qualityProfile,
          speedProfile: info.speedProfile,
          reliabilityProfile: info.reliabilityProfile,
        },
        update: {},
      });
    }
    console.log(`ModelConfig seeded (${Object.keys(models).length} models)`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());