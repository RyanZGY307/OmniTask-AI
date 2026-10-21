import { Router, Response } from 'express';
import { prisma, prismaConversation, prismaUser } from '../services/db';
import { authMiddleware, adminAuth, AuthRequest } from '../middleware/auth';
import { randomUUID } from 'crypto';
import { headroom } from '../services/billing/modelLimits';
import {
  upsertProviderConnection, deleteProviderConnection, listProviderConnections,
  fetchProviderModelList, PROVIDER_CATEGORIES,
} from '../services/providerConfig';
import { getKeyPoolStats, rebuildApiKeyPools } from '../services/apiKeyPool';
import { rosterList, rosterSummary } from '../services/skillRoster';
import { promoteToGlobal, rejectInstall } from '../services/skillPromotion';

const router = Router();
router.use(authMiddleware);

// ================================================================
// Provider connections — admin-managed Base URLs + API key pools
// (up to 30 keys per connection; least-used rotation + fail-over).
// Keys live in the DB and are NEVER returned in clear: list views are
// masked (first 4 / last 4 chars).
// ================================================================

function maskKey(k: string): string {
  if (!k) return '';
  if (k.length <= 8) return `${k.slice(0, 2)}...`;
  return `${k.slice(0, 4)}...${k.slice(-4)}`;
}

router.get('/provider-connections', adminAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await listProviderConnections();
    const poolStats = getKeyPoolStats();
    res.json({
      connections: rows.map((c: any) => ({ ...c, apiKeys: (c.apiKeys || []).map(maskKey) })),
      poolStats,
      categories: PROVIDER_CATEGORIES,
    });
  } catch (err: any) { res.status(500).json({ error: err?.message || 'Failed to list provider connections' }); }
});

router.post('/provider-connections', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { provider, tier, label, baseUrl, baseUrlRoot, apiKeys, apiLimit, carrierLimit, enabled } = req.body;
    if (!provider || !baseUrl || !Array.isArray(apiKeys)) {
      return res.status(400).json({ error: 'provider、baseUrl、apiKeys（数组）必填' });
    }
    const conn = await upsertProviderConnection({
      provider: String(provider),
      tier: tier === 'PRO' ? 'PRO' : 'FREE',
      label: label ? String(label) : undefined,
      baseUrl: String(baseUrl),
      baseUrlRoot: baseUrlRoot ? String(baseUrlRoot) : null,
      apiKeys: (apiKeys as string[]).map((k: string) => String(k).trim()).filter(Boolean), // 无数量上限
      apiLimit: apiLimit as any,
      carrierLimit: carrierLimit as any,
      enabled: enabled !== false,
    });
    await rebuildApiKeyPools();
    res.json({ success: true, connection: { ...conn, apiKeys: (conn.apiKeys || []).map(maskKey) } });
  } catch (err: any) { res.status(500).json({ error: err?.message || '保存供应商连接失败' }); }
});

// 删除：provider 名可能同时存在 FREE 与 PRO 两套；tier 缺省删 FREE。
router.delete('/provider-connections/:provider', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const provider = String(req.params.provider);
    const tier = (req.query.tier === 'PRO' ? 'PRO' : 'FREE') as 'FREE' | 'PRO';
    await deleteProviderConnection(provider, tier);
    await rebuildApiKeyPools();
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err?.message || '删除失败' }); }
});

// Key editor view — 需完整 key 以便往返编辑（列表视图保持掩码）。
// 需带 tier（同一 provider 名可能 FREE/PRO 各一套）。
router.get('/provider-connections/:provider/keys', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const provider = String(req.params.provider);
    const tier = (req.query.tier === 'PRO' ? 'PRO' : 'FREE') as 'FREE' | 'PRO';
    const rows = await prismaUser.providerConnection.findMany({ where: { provider, tier } });
    if (!rows.length) return res.status(404).json({ error: '供应商连接不存在' });
    const keys = JSON.parse(rows[0].apiKeys || '[]') as string[];
    res.json({ provider, tier, apiKeys: keys });
  } catch (err: any) { res.status(500).json({ error: err?.message || '获取密钥失败' }); }
});

// 拉取列表 — fetch the model list from a Base URL (OpenAI-compatible
// /models first, Google-native listing as fallback). Feeds the admin
// 模型添加 form's 拉取列表 button.
router.post('/models/fetch-list', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { baseUrl, apiKey } = req.body;
    if (!baseUrl) return res.status(400).json({ error: 'baseUrl 必填' });
    const models = await fetchProviderModelList(String(baseUrl), apiKey ? String(apiKey) : undefined);
    res.json({ models });
  } catch (err: any) { res.status(500).json({ error: err?.message || '拉取模型列表失败' }); }
});

// ================================================================
// Admin Token-Usage View — the ONLY place ACTUAL + DISPLAY coexist.
// The user-facing path returns display-only (UserTokenView). This
// endpoint is admin-gated and exposes providerActual, billingDetail,
// and modelLimit provenance for cost analysis / model evolution.
// ================================================================

export interface AdminTokenView {
  requestInfo: {
    userId: string;
    model: string;
    mode: string;
    timestamp: string;
  };
  providerActual: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  userDisplay: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    creditsUsed: number;
  };
  billingDetail: {
    multiplier: number;
    overflowTransferred: boolean;
    overflowAmount: number;
  };
  modelLimit: {
    outputTokenLimit: number | null;
    source: string;
    verifiedAt: string | null;
    status: string;
    headroom: number | null;
  };
}

router.get('/token-usage/:messageId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const messageId = String(req.params.messageId);
    const usage = await prisma.tokenUsage.findFirst({
      where: { messageId },
      orderBy: { createdAt: 'desc' },
    });
    if (!usage) return res.status(404).json({ error: 'No token usage found for this message' });

    const limit = usage.verifiedOutputLimit;
    const view: AdminTokenView = {
      requestInfo: {
        userId: usage.userId,
        model: usage.model,
        mode: usage.mode,
        timestamp: usage.createdAt.toISOString(),
      },
      providerActual: {
        inputTokens: usage.actualInputTokens,
        outputTokens: usage.actualOutputTokens,
        totalTokens: usage.actualTotalTokens,
      },
      userDisplay: {
        inputTokens: usage.displayInputTokens,
        outputTokens: usage.displayOutputTokens,
        totalTokens: usage.displayTotalTokens,
        creditsUsed: 0, // credits live on Message.creditsCost; see /messages
      },
      billingDetail: {
        multiplier: usage.multiplier,
        overflowTransferred: usage.overflowTransferred,
        overflowAmount: usage.overflowAmount,
      },
      modelLimit: {
        outputTokenLimit: limit,
        source: usage.limitSource || 'unknown',
        verifiedAt: usage.limitVerifiedAt?.toISOString() ?? null,
        status: limit ? 'verified' : 'unknown',
        headroom: headroom(limit, usage.actualOutputTokens),
      },
    };
    res.json(view);
  } catch {
    res.status(500).json({ error: 'Failed to load token usage' });
  }
});

// Per-user consumption summary — display-only, no actual tokens.
router.get('/token-usage/user/:userId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = String(req.params.userId);
    const rows = await prisma.tokenUsage.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const totalDisplay = rows.reduce((s, r) => s + r.displayTotalTokens, 0);
    res.json({
      userId,
      sampleSize: rows.length,
      totalDisplayTokens: totalDisplay,
      records: rows.map((r) => ({
        messageId: r.messageId,
        model: r.model,
        mode: r.mode,
        displayTotal: r.displayTotalTokens,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch {
    res.status(500).json({ error: 'Failed to load user consumption' });
  }
});

// Model efficiency (ACTUAL only) — feeds cost analysis + Model Evolution.
router.get('/token-usage/model/:model', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const model = String(req.params.model);
    const agg = await prisma.tokenUsage.aggregate({
      where: { model },
      _sum: { actualInputTokens: true, actualOutputTokens: true, actualTotalTokens: true },
      _count: { _all: true },
    });
    res.json({
      model,
      calls: agg._count._all,
      actual: {
        inputTokens: agg._sum.actualInputTokens || 0,
        outputTokens: agg._sum.actualOutputTokens || 0,
        totalTokens: agg._sum.actualTotalTokens || 0,
      },
    });
  } catch {
    res.status(500).json({ error: 'Failed to load model efficiency' });
  }
});

router.get('/dashboard', adminAuth, async (_req, res: Response) => {
  try {
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [
      totalUsers, activeUsers, paidUsers, proUsers, ultraUsers, totalConversations,
      activeConversations, totalMessages, todayMessages, pendingOrders, completedToday,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { OR: [{ creditBalance: { gt: 0 } }, { subscriptionEnd: { gt: new Date() } }] } }),
      prisma.user.count({ where: { subscriptionTier: { in: ['PRO', 'ULTRA'] } } }),
      prisma.user.count({ where: { subscriptionTier: 'ULTRA' } }),
      prismaConversation.conversation.count(),
      prismaConversation.conversation.count({ where: { updatedAt: { gte: weekAgo } } }),
      prismaConversation.message.count(),
      prismaConversation.message.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.paymentOrder.count({ where: { status: { in: ['AWAITING_PAYMENT', 'PROOF_UPLOADED', 'AI_REVIEWING'] } } }),
      prisma.paymentOrder.findMany({ where: { status: 'COMPLETED', updatedAt: { gte: todayStart } }, select: { lockedPriceUsd: true } }),
    ]);
    const totalCredits = await prisma.creditTransaction.aggregate({ _sum: { amount: true } });
    res.json({
      totalUsers, activeUsers, paidUsers, proUsers, ultraUsers,
      totalConversations, activeConversations, totalMessages, todayMessages,
      todayRevenue: completedToday.reduce((s, o) => s + (o.lockedPriceUsd || 0), 0),
      pendingPayments: pendingOrders, totalCredits: totalCredits._sum.amount || 0,
    });
  } catch { res.status(500).json({ error: '获取仪表盘数据失败' }); }
});

router.get('/api-keys', adminAuth, async (_req, res: Response) => {
  try {
    const rows = await prisma.providerConnection.findMany({ select: { provider: true, tier: true, apiKeys: true, enabled: true } });
    const pools: Record<string, { tier: string; keys: number; enabled: boolean }[]> = {};
    for (const r of rows) {
      const arr = JSON.parse(r.apiKeys || '[]');
      (pools[r.provider] = pools[r.provider] || []).push({ tier: r.tier, keys: Array.isArray(arr) ? arr.length : 0, enabled: r.enabled });
    }
    res.json({ pools });
  } catch { res.status(500).json({ error: '获取 API Key 池状态失败' }); }
});

router.get('/users', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = parseInt(String(req.query.limit)) || 20;
    const search = String(req.query.search || '');
    const skip = (page - 1) * limit;
    const where: any = {};
    if (search) where.OR = [{ email: { contains: search } }, { username: { contains: search } }];
    const [users, total] = await Promise.all([
      prisma.user.findMany({ where, skip, take: limit, select: { id: true, email: true, username: true, role: true, subscriptionTier: true, creditBalance: true, isActive: true, region: true, language: true, currency: true, gender: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
      prisma.user.count({ where }),
    ]);
    res.json({ users, total, page, pages: Math.ceil(total / limit) });
  } catch { res.status(500).json({ error: '获取用户列表失败' }); }
});

// 用户详情聚合：支付记录、模型使用、数据量估算（跨库聚合）
router.get('/users/:id/detail', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = String(req.params.id);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, username: true, region: true, language: true, currency: true, gender: true, role: true, subscriptionTier: true, creditBalance: true, isActive: true, createdAt: true } });
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const [orders, modelUsageRaw, conversations, messageCount, flaggedCount] = await Promise.all([
      prisma.paymentOrder.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.modelUsage.groupBy({ by: ['model'], where: { userId }, _sum: { tokenCount: true, callCount: true } }),
      prismaConversation.conversation.findMany({ where: { userId }, select: { id: true, isSafetyFlagged: true } }),
      prismaConversation.message.count({ where: { conversation: { userId } } }),
      prismaConversation.flaggedConversation.count({ where: { userId } }),
    ]);

    // 数据量估算：消息字符数（近似字节） + 会话/记录条数换算
    const messageBytes = await prismaConversation.$queryRaw<Array<{ total: bigint | null }>>`
      SELECT COALESCE(SUM(OCTET_LENGTH(m."content")), 0) AS total
      FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
      WHERE c."userId" = ${userId}`;
    const contentBytes = Number(messageBytes[0]?.total ?? 0);
    const estimateBytes = contentBytes + messageCount * 120 + conversations.length * 300;

    res.json({
      user,
      orders,
      modelUsage: modelUsageRaw,
      stats: {
        conversationCount: conversations.length,
        messageCount,
        flaggedConversationCount: flaggedCount,
        flaggedTotal: conversations.filter((c) => c.isSafetyFlagged).length,
        contentBytes,
        estimateBytes,
      },
    });
  } catch { res.status(500).json({ error: '获取用户详情失败' }); }
});

// 硬删除用户：user 库级联删除 + conversation 库会话/消息/标记手工清理
router.delete('/users/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = String(req.params.id);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const convIds = (await prismaConversation.conversation.findMany({ where: { userId }, select: { id: true } })).map((c) => c.id);
    if (convIds.length > 0) {
      await prismaConversation.message.deleteMany({ where: { conversationId: { in: convIds } } });
      await prismaConversation.flaggedConversation.deleteMany({ where: { conversationId: { in: convIds } } });
      await prismaConversation.conversation.deleteMany({ where: { userId } });
    }
    await prismaConversation.flaggedConversation.deleteMany({ where: { userId } });

    // LogEntry.userId 为外键 SetNull，手动置空后删除用户（其余表靠外键 CASCADE）
    await prisma.logEntry.updateMany({ where: { userId }, data: { userId: null } });
    await prisma.user.delete({ where: { id: userId } });
    res.json({ success: true, deleted: { conversations: convIds.length } });
  } catch (e: any) {
    console.error('[Admin] 删除用户失败', e?.message);
    res.status(500).json({ error: '删除用户失败: ' + (e?.message || 'unknown') });
  }
});

// ===== 标记对话管理 =====
router.get('/flagged', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = parseInt(String(req.query.limit)) || 20;
    const skip = (page - 1) * limit;
    const level = String(req.query.level || '');
    const where: any = {};
    if (level) where.level = level;
    const [rows, total] = await Promise.all([
      prismaConversation.flaggedConversation.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      prismaConversation.flaggedConversation.count({ where }),
    ]);
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const users = userIds.length
      ? await prismaUser.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
      : [];
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    res.json({
      flagged: rows.map((r) => ({ ...r, messagesJson: undefined, userEmail: emailById.get(r.userId) || null })),
      total, page, pages: Math.ceil(total / limit),
    });
  } catch { res.status(500).json({ error: '获取标记列表失败' }); }
});

router.get('/flagged/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const row = await prismaConversation.flaggedConversation.findUnique({ where: { id: String(req.params.id) } });
    if (!row) return res.status(404).json({ error: '标记不存在' });
    const user = await prismaUser.user.findUnique({ where: { id: row.userId }, select: { email: true } });
    res.json({ flag: { ...row, messages: JSON.parse(row.messagesJson || '[]'), userEmail: user?.email || null } });
  } catch { res.status(500).json({ error: '获取标记详情失败' }); }
});

router.get('/conversations', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = parseInt(String(req.query.limit)) || 20;
    const userId = String(req.query.userId || '');
    const skip = (page - 1) * limit;
    const where: any = {};
    if (userId) where.userId = userId;
    const [rows, total] = await Promise.all([
      prismaConversation.conversation.findMany({ where, skip, take: limit, orderBy: { updatedAt: 'desc' } }),
      prismaConversation.conversation.count({ where }),
    ]);
    // Cross-database join: user lives in the user DB, so fetch profiles
    // here and attach after the fact (Prisma cannot include a relation
    // that crosses datasource boundaries).
    const userRefs = [...new Set(rows.map((r) => r.userId))];
    const users = userRefs.length
      ? await prismaUser.user.findMany({ where: { id: { in: userRefs } }, select: { id: true, username: true, email: true } })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    const conversations = rows.map((r) => ({ ...r, user: userById.get(r.userId) ?? null }));
    res.json({ conversations, total, page, pages: Math.ceil(total / limit) });
  } catch { res.status(500).json({ error: '获取对话列表失败' }); }
});

router.get('/users/:userId/conversations', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const conversations = await prismaConversation.conversation.findMany({
      where: { userId: String(req.params.userId) },
      include: { messages: { take: 5, orderBy: { createdAt: 'desc' } } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    res.json({ conversations });
  } catch { res.status(500).json({ error: '获取失败' }); }
});

router.get('/payments', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || '');
    const page = parseInt(String(req.query.page)) || 1;
    const limit = parseInt(String(req.query.limit)) || 20;
    const skip = (page - 1) * limit;
    const where: any = {};
    if (status) where.status = status;
    const [orders, total] = await Promise.all([
      prisma.paymentOrder.findMany({ where, skip, take: limit, include: { user: { select: { username: true, email: true } }, proofs: true, reviews: true }, orderBy: { createdAt: 'desc' } }),
      prisma.paymentOrder.count({ where }),
    ]);
    res.json({ orders, total, page, pages: Math.ceil(total / limit) });
  } catch { res.status(500).json({ error: '获取支付列表失败' }); }
});

router.post('/payments/:orderId/approve', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = String(req.params.orderId);
    const order = await prisma.paymentOrder.findUnique({ where: { orderId }, include: { user: true } });
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status === 'PAID') return res.json({ success: true, alreadyPaid: true });

    // Conditional transition: only approves orders still awaiting approval.
    // Prevents double-credit-grant on concurrent / replayed approvals.
    const transition = await prisma.paymentOrder.updateMany({
      where: { orderId, status: { in: ['AI_REVIEWING', 'PROOF_UPLOADED', 'UNDERPAID'] } },
      data: { status: 'PAID' },
    });
    if (transition.count === 0) return res.status(409).json({ error: '订单状态不可审批' });

    // Credit grant goes through the unified Billing Ledger (R8):
    // idempotent, atomic with CreditBatch, no off-ledger balance writes.
    const { grantCredits } = await import('../services/finance/billingLedger');
    const { PERMANENT_PACK_VALID_DAYS } = await import('../config');
    if (order.plan.startsWith('pack-')) {
      const credits = parseInt(order.plan.replace('pack-', ''));
      if (credits > 0) {
        await grantCredits({
          userId: order.userId,
          orderId,
          credits,
          idempotencyKey: `admin_approve_${orderId}`,
          description: `积分包购买: ${credits} 积分（永久有效）`,
          metadata: { source: 'admin_approval' },
          batch: { validDays: PERMANENT_PACK_VALID_DAYS, source: 'purchase' },
        });
      }
    } else {
      const tier = order.plan.includes('pro') ? 'PRO' : 'ULTRA';
      const { getDynamicGrants } = await import('../services/configSync');
      const grant = getDynamicGrants()[tier as 'PRO' | 'ULTRA'] || 0;
      if (grant > 0) {
        // Pro: yearly = 12 monthly batches of 3000 (30-day each);
        // monthly/legacy = single 30-day batch.
        const batches = order.plan.includes('yearly') && tier === 'PRO' ? 12 : 1;
        for (let i = 0; i < batches; i++) {
          await grantCredits({
            userId: order.userId,
            orderId,
            credits: grant,
            idempotencyKey: i === 0 ? `admin_approve_${orderId}` : `admin_approve_${orderId}_batch_${i}`,
            description: batches > 1 ? `Pro 订阅购买: ${order.plan}（第 ${i + 1}/${batches} 月批次）` : `订阅购买: ${order.plan}`,
            metadata: { source: 'admin_approval', batchIndex: i, batchCount: batches },
            batch: { validDays: 30, source: 'subscription' },
          });
        }
      }
      const end = new Date();
      end.setMonth(end.getMonth() + (order.plan.includes('yearly') ? 12 : 1));
      await prisma.user.update({ where: { id: order.userId }, data: { subscriptionTier: tier as any, subscriptionEnd: end } });
    }
    await prisma.paymentAuditLog.create({ data: { orderId, action: 'admin_approved', detail: `Approved by admin ${req.user!.id}` } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '审批失败' }); }
});

router.post('/payments/:orderId/reject', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = String(req.params.orderId);
    const { reason } = req.body;
    await prisma.paymentOrder.update({ where: { orderId }, data: { status: 'CANCELLED' } });
    await prisma.paymentAuditLog.create({ data: { orderId, action: 'admin_rejected', detail: reason || 'Rejected by admin' } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '拒绝失败' }); }
});

router.get('/qr', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const codes = await prisma.paymentQRCode.findMany();
    res.json({ codes });
  } catch { res.status(500).json({ error: '获取失败' }); }
});

router.post('/qr', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { method, imageUrl } = req.body;
    const qr = await prisma.paymentQRCode.upsert({ where: { method }, update: { imageUrl }, create: { method, imageUrl } });
    res.json({ qr });
  } catch { res.status(500).json({ error: '更新失败' }); }
});

router.post('/invites', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { email } = req.body;
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const invite = await prisma.adminInvite.create({ data: { token, email, expiresAt } });
    res.json({ invite });
  } catch { res.status(500).json({ error: '生成邀请码失败' }); }
});

router.get('/stats', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const days = parseInt(String(req.query.days)) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [newUsers, newMessages, newOrders] = await Promise.all([
      prisma.user.count({ where: { createdAt: { gte: since } } }),
      prismaConversation.message.count({ where: { createdAt: { gte: since } } }),
      prisma.paymentOrder.count({ where: { createdAt: { gte: since } } }),
    ]);
    res.json({ newUsers, newMessages, newOrders, period: days });
  } catch { res.status(500).json({ error: '获取统计失败' }); }
});

router.get('/models', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { getDynamicModels } = await import('../services/configSync');
    const models = getDynamicModels();
    res.json({ models });
  } catch { res.status(500).json({ error: '获取模型列表失败' }); }
});

router.post('/models', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { modelKey, provider, apiModel, displayName, vendor, tier, maxTokens, contextWindow, costPer1k, costPer1M, category, status, enabled, capabilities, supportsReasoning, supportsTools, supportsVision, supportsStreaming, supportsStructuredOutput, qualityProfile, speedProfile, reliabilityProfile, rateLimit } = req.body;
    // modelKey 可省略：由 apiModel 派生（小写连字符）。同 apiModel 可分 FREE/PRO 两条，此时传 modelKey 区分。
    const key = modelKey || (apiModel ? String(apiModel).toLowerCase().replace(/[^a-z0-9]+/g, '-') : undefined);
    if (!key || !displayName) return res.status(400).json({ error: 'apiModel 和 displayName 必填' });
    // 管理端以 积分/1M 为单位；注册表存 积分/1k。capabilities 是 JSON 字符串列。
    const cost1k = costPer1M != null ? Number(costPer1M) / 1000 : (costPer1k != null ? Number(costPer1k) : 0);
    const capStr = JSON.stringify(Array.isArray(capabilities) ? capabilities : (capabilities ? [capabilities] : []));
    const rateLimitStr = rateLimit && Object.keys(rateLimit).length ? JSON.stringify(rateLimit) : '';
    await prisma.modelConfig.upsert({
      where: { modelKey: key },
      create: {
        modelKey: key, provider: provider || 'custom', apiModel: apiModel || key, displayName,
        vendor: vendor ? String(vendor) : '', rateLimit: rateLimitStr,
        tier: tier || 'FREE', maxTokens: maxTokens || 8192, contextWindow: contextWindow || 32768,
        costPer1k: cost1k, category: category || 'general', status: status || 'online',
        enabled: enabled !== false, capabilities: capStr,
        supportsReasoning: supportsReasoning || false, supportsTools: supportsTools || false,
        supportsVision: supportsVision || false, supportsStreaming: supportsStreaming !== false,
        supportsStructuredOutput: supportsStructuredOutput || false,
        qualityProfile: qualityProfile || 5, speedProfile: speedProfile || 5, reliabilityProfile: reliabilityProfile || 5,
      },
      update: {
        provider: provider || undefined, apiModel: apiModel || undefined, displayName: displayName || undefined,
        vendor: vendor !== undefined ? String(vendor) : undefined, rateLimit: rateLimit !== undefined ? rateLimitStr : undefined,
        tier: tier || undefined, maxTokens: maxTokens || undefined, contextWindow: contextWindow || undefined,
        costPer1k: cost1k, category: category || undefined, status: status || undefined,
        enabled: enabled !== undefined ? enabled : undefined, capabilities: capabilities !== undefined ? capStr : undefined,
        supportsReasoning: supportsReasoning !== undefined ? supportsReasoning : undefined,
        supportsTools: supportsTools !== undefined ? supportsTools : undefined,
        supportsVision: supportsVision !== undefined ? supportsVision : undefined,
        supportsStreaming: supportsStreaming !== undefined ? supportsStreaming : undefined,
        supportsStructuredOutput: supportsStructuredOutput !== undefined ? supportsStructuredOutput : undefined,
        qualityProfile: qualityProfile !== undefined ? qualityProfile : undefined,
        speedProfile: speedProfile !== undefined ? speedProfile : undefined,
        reliabilityProfile: reliabilityProfile !== undefined ? reliabilityProfile : undefined,
      },
    });
    const { refreshModelConfigs } = await import('../services/configSync');
    await refreshModelConfigs();
    res.json({ success: true, modelKey: key });
  } catch (err: any) { res.status(500).json({ error: err.message || '操作失败' }); }
});

router.delete('/models/:modelKey', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const key = String(req.params.modelKey);
    await prisma.modelConfig.delete({ where: { modelKey: key } }).catch(() => null);
    const { refreshModelConfigs } = await import('../services/configSync');
    await refreshModelConfigs();
    const { dropModelScope } = await import('../services/rateLimiter');
    dropModelScope(key);
    res.json({ success: true });
  } catch { res.status(500).json({ error: '删除失败' }); }
});

// 修改已存在模型的配置（含 API 价格）。
//
// 为什么需要它：POST /models 是 upsert 且 displayName 必填，因此"只想改价格"
// 也必须重传全部字段；而管理页此前只提供添加/删除，导致改价的唯一途径是
// 删除后重建——这会丢掉 usage 历史关联、限流作用域与用户已选的模型。
// 同文件的 PUT /credit-packs/:id、PUT /users/:id 已是本项目的编辑范式。
//
// 与 POST /models 的关键差异：
//   1. 用 update 而非 upsert —— modelKey 不存在就 404，不会顺手创建新模型。
//   2. 全部字段可省略 —— 只提交要改的项，未提交的保持原值不变。
//   3. modelKey 不可改（它是身份，不是配置）。
//   4. 拒绝空请求体，避免误调用把整行写成默认值。
router.put('/models/:modelKey', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const key = String(req.params.modelKey);

    const {
      modelKey: _ignoredKey,   // 显式忽略：不允许通过本端点改身份
      id: _ignoredId,
      displayName, vendor, tier, maxTokens, contextWindow,
      costPer1k, costPer1M, category, status, enabled,
      capabilities, supportsReasoning, supportsTools, supportsVision,
      supportsStreaming, supportsStructuredOutput,
      qualityProfile, speedProfile, reliabilityProfile, rateLimit,
    } = req.body || {};

    // 至少要有一样可改的，否则视为误调用。
    const hasAny = [displayName, vendor, tier, maxTokens, contextWindow, costPer1k,
      costPer1M, category, status, enabled, capabilities, supportsReasoning,
      supportsTools, supportsVision, supportsStreaming, supportsStructuredOutput,
      qualityProfile, speedProfile, reliabilityProfile, rateLimit]
      .some((v) => v !== undefined);
    if (!hasAny) return res.status(400).json({ error: '没有提供任何可修改字段' });

    // API 价格：管理端用「积分/1M」为单位，注册表用「积分/1k」。
    // FREE 档模型固定为 0——否则用户端"免费"标签与实际计费不一致。
    let cost1k: number | undefined;
    if (costPer1M !== undefined || costPer1k !== undefined) {
      const raw = costPer1M !== undefined ? Number(costPer1M) / 1000 : Number(costPer1k);
      if (!Number.isFinite(raw) || raw < 0) {
        return res.status(400).json({ error: '价格必须是非负数字' });
      }
      cost1k = raw;
    }

    // 校验要改的字段存在（update 在缺失时抛 P2025，需转成 404）。
    const existing = await prisma.modelConfig.findUnique({ where: { modelKey: key } }).catch(() => null);
    if (!existing) return res.status(404).json({ error: `模型不存在：${key}` });

    const capStr = capabilities !== undefined
      ? JSON.stringify(Array.isArray(capabilities) ? capabilities : [capabilities])
      : undefined;
    const rateLimitStr = rateLimit !== undefined
      ? (rateLimit && Object.keys(rateLimit).length ? JSON.stringify(rateLimit) : '')
      : undefined;

    const nextTier = tier !== undefined ? String(tier) : existing.tier;
    const effectiveCost = cost1k !== undefined ? cost1k
      : existing.costPer1k;

    const updated = await prisma.modelConfig.update({
      where: { modelKey: key },
      data: {
        displayName: displayName !== undefined ? String(displayName) : undefined,
        vendor: vendor !== undefined ? String(vendor) : undefined,
        tier: nextTier,
        maxTokens: maxTokens !== undefined ? Number(maxTokens) : undefined,
        contextWindow: contextWindow !== undefined ? Number(contextWindow) : undefined,
        // FREE 档强制 0，防止"免费"标签与真实计费脱节
        costPer1k: nextTier === 'FREE' ? 0 : effectiveCost,
        category: category !== undefined ? String(category) : undefined,
        status: status !== undefined ? String(status) : undefined,
        enabled: enabled !== undefined ? enabled : undefined,
        capabilities: capStr,
        supportsReasoning: supportsReasoning,
        supportsTools: supportsTools,
        supportsVision: supportsVision,
        supportsStreaming: supportsStreaming,
        supportsStructuredOutput: supportsStructuredOutput,
        qualityProfile: qualityProfile,
        speedProfile: speedProfile,
        reliabilityProfile: reliabilityProfile,
        rateLimit: rateLimitStr,
      },
    });

    // 价格/厂商等信息都是运行时从注册表读的，改了必须热加载。
    const { refreshModelConfigs } = await import('../services/configSync');
    await refreshModelConfigs();

    res.json({ success: true, modelKey: key, model: updated });
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: '模型不存在' });
    res.status(500).json({ error: err.message || '更新失败' });
  }
});

router.get('/credit-packs', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { getDynamicPacks } = await import('../services/configSync');
    const packs = getDynamicPacks();
    res.json({ packs });
  } catch { res.status(500).json({ error: '获取积分包失败' }); }
});

router.post('/credit-packs', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id, credits, price, currency } = req.body;
    if (!id || credits == null || price == null) return res.status(400).json({ error: 'id、credits、price 必填' });
    await prisma.creditPack.upsert({
      where: { id },
      create: { id, credits: Number(credits), price: Number(price), currency: currency || 'USD', isActive: true },
      update: { credits: Number(credits), price: Number(price), currency: currency || undefined, isActive: true },
    });
    const { refreshCreditPacks } = await import('../services/configSync');
    await refreshCreditPacks();
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message || '操作失败' }); }
});

router.put('/credit-packs/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { credits, price, currency, isActive } = req.body;
    await prisma.creditPack.update({ where: { id: String(req.params.id) }, data: {
      ...(credits != null ? { credits: Number(credits) } : {}),
      ...(price != null ? { price: Number(price) } : {}),
      ...(currency != null ? { currency } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
    }});
    const { refreshCreditPacks } = await import('../services/configSync');
    await refreshCreditPacks();
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message || '操作失败' }); }
});

router.delete('/credit-packs/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.creditPack.update({ where: { id: String(req.params.id) }, data: { isActive: false } });
    const { refreshCreditPacks } = await import('../services/configSync');
    await refreshCreditPacks();
    res.json({ success: true });
  } catch { res.status(500).json({ error: '停用失败' }); }
});

router.get('/subscription-pricing', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.subscriptionPricing.findMany();
    res.json({ pricing: rows });
  } catch { res.status(500).json({ error: '获取订阅定价失败' }); }
});

router.post('/subscription-pricing', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { tier, monthlyUsd, yearlyUsd, creditGrant } = req.body;
    if (!tier || !monthlyUsd) return res.status(400).json({ error: 'tier 和 monthlyUsd 必填' });
    await prisma.subscriptionPricing.upsert({
      where: { tier },
      create: { tier, monthlyUsd: Number(monthlyUsd), yearlyUsd: Number(yearlyUsd || 0), creditGrant: Number(creditGrant || 0) },
      update: {
        monthlyUsd: Number(monthlyUsd),
        yearlyUsd: yearlyUsd != null ? Number(yearlyUsd) : undefined,
        creditGrant: creditGrant != null ? Number(creditGrant) : undefined,
      },
    });
    const { refreshSubscriptionPricing } = await import('../services/configSync');
    await refreshSubscriptionPricing();
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message || '操作失败' }); }
});

const updateAdminUserHandler = async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {};
    const data: Record<string, any> = {};
    // Whitelist: only fields admin tooling is expected to manage.
    // role/passwordHash/creditBalance are deliberately excluded to prevent
    // privilege escalation and off-ledger credit manipulation.
    if (b.username != null) data.username = String(b.username);
    if (b.email != null) data.email = String(b.email);
    if (b.region != null) data.region = String(b.region);
    if (b.language != null) data.language = String(b.language);
    if (b.currency != null) data.currency = String(b.currency);
    if (b.subscriptionTier != null) data.subscriptionTier = String(b.subscriptionTier);
    if (b.subscriptionEnd != null) data.subscriptionEnd = new Date(b.subscriptionEnd);
    if (b.isActive !== undefined) data.isActive = Boolean(b.isActive);
    if (b.gender !== undefined) { const g = String(b.gender || ''); if (g === '' || g === 'male' || g === 'female') data.gender = g || null; }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: '无可更新字段' });
    const user = await prisma.user.update({ where: { id: String(req.params.id) }, data });
    res.json({ user });
  } catch { res.status(500).json({ error: '更新失败' }); }
};
router.put('/users/:id', adminAuth, updateAdminUserHandler);
// The admin UI edits users via PATCH (partial update semantics); keep PUT as the canonical form.
router.patch('/users/:id', adminAuth, updateAdminUserHandler);

router.delete('/conversations/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await prismaConversation.conversation.delete({ where: { id: String(req.params.id) } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '删除失败' }); }
});

// ================================================================
// Skills — global catalog CRUD (matches the /admin/skills page) plus
// the cross-account install roster + admin curation (promote / reject).
//
// /admin/skills CRUD operates on the simple global Skill catalog
// (prismaUser.skill). The roster endpoints see EVERY account's
// installed skills (UserInstalledSkill) and can promote one into the
// formal global pool (prismaKnowledge.skill) via SkillPublishGuard +
// S1 enqueue, or reject it.
// ================================================================

router.get('/skills', adminAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const skills = await prisma.skill.findMany({ orderBy: { name: 'asc' } });
    res.json({ skills });
  } catch { res.status(500).json({ error: 'Failed to list skills' }); }
});

router.post('/skills', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, prompt, category } = req.body;
    if (!name || !prompt) return res.status(400).json({ error: 'name 和 prompt 必填' });
    const skill = await prisma.skill.create({
      data: { name, description: description || null, prompt, category: category || null },
    });
    res.json({ skill });
  } catch { res.status(500).json({ error: 'Failed to create skill' }); }
});

router.delete('/skills/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.skill.delete({ where: { id: String(req.params.id) } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to delete skill' }); }
});

// ---- Install roster (all accounts) ----

router.get('/skills/roster', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { status, scanStatus, sourceType, ownerEmail, search, page, limit } = req.query;
    const data = await rosterList({
      status: status ? String(status) : undefined,
      scanStatus: scanStatus ? String(scanStatus) : undefined,
      sourceType: sourceType ? String(sourceType) : undefined,
      ownerEmail: ownerEmail ? String(ownerEmail) : undefined,
      search: search ? String(search) : undefined,
      page: page ? parseInt(String(page)) : undefined,
      limit: limit ? parseInt(String(limit)) : undefined,
    });
    const summary = await rosterSummary();
    res.json({ ...data, summary });
  } catch { res.status(500).json({ error: 'Failed to load roster' }); }
});

router.post('/skills/roster/:id/promote', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await promoteToGlobal(String(req.params.id), req.user!.id);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err?.message || 'Promotion failed' }); }
});

router.post('/skills/roster/:id/reject', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const reason = req.body?.reason ? String(req.body.reason) : undefined;
    const result = await rejectInstall(String(req.params.id), reason);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json(result);
  } catch { res.status(500).json({ error: 'Rejection failed' }); }
});

export default router;