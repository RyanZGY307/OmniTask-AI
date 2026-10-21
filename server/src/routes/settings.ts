import { Router, Response } from 'express';
import { prisma } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

// ========== Get Settings ==========
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    let settings = await prisma.userSetting.findUnique({ where: { userId: req.user!.id } });
    if (!settings) {
      settings = await prisma.userSetting.create({ data: { userId: req.user!.id } });
    }
    res.json({ settings });
  } catch { res.status(500).json({ error: '获取设置失败' }); }
});

// ========== Update Settings ==========
router.put('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { defaultModel, defaultMode, theme, enableVoice, enableSearch, teacherStyle, language, region } = req.body;
    const settings = await prisma.userSetting.upsert({
      where: { userId: req.user!.id },
      update: { defaultModel, defaultMode, theme, enableVoice, enableSearch, teacherStyle },
      create: { userId: req.user!.id, defaultModel, defaultMode, theme, enableVoice, enableSearch, teacherStyle },
    });
    // 界面语言 / 地区存于 User 本体（不只是 UserSetting）
    if (language !== undefined || region !== undefined) {
      const userUpdate: Record<string, string> = {};
      // BCP-47 或 ISO-639，上限防止注入过长的无效值
      if (typeof language === 'string' && /^[a-zA-Z0-9-]{2,12}$/.test(language)) userUpdate.language = language;
      if (typeof region === 'string' && /^[A-Z]{2}$/.test(region)) userUpdate.region = region;
      if (Object.keys(userUpdate).length > 0) {
        await prisma.user.update({ where: { id: req.user!.id }, data: userUpdate });
      }
    }
    res.json({ settings });
  } catch { res.status(500).json({ error: '更新设置失败' }); }
});

// ========== Auto Model Pool ==========
router.get('/model-pool', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const settings = await prisma.userSetting.findUnique({ where: { userId: req.user!.id } });
    res.json({ pool: settings?.autoModelPool || null });
  } catch { res.status(500).json({ error: '获取模型池失败' }); }
});

router.put('/model-pool', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { pool } = req.body;
    await prisma.userSetting.upsert({
      where: { userId: req.user!.id },
      update: { autoModelPool: pool },
      create: { userId: req.user!.id, autoModelPool: pool },
    });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '更新模型池失败' }); }
});

// ========== Mode Model Preferences ==========
router.get('/mode-preferences', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const settings = await prisma.userSetting.findUnique({ where: { userId: req.user!.id } });
    res.json({ preferences: settings?.modeModelPreferences || {} });
  } catch { res.status(500).json({ error: '获取偏好失败' }); }
});

router.put('/mode-preferences', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { preferences } = req.body;
    await prisma.userSetting.upsert({
      where: { userId: req.user!.id },
      update: { modeModelPreferences: preferences },
      create: { userId: req.user!.id, modeModelPreferences: preferences },
    });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '更新偏好失败' }); }
});

// ========== Glass Settings ==========
router.get('/glass', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const settings = await prisma.userSetting.findUnique({ where: { userId: req.user!.id } });
    res.json({
      glass: {
        enabled: settings?.glassEnabled ?? true,
        blur: settings?.glassBlur ?? 12,
        opacity: settings?.glassOpacity ?? 0.06,
        borderOpacity: settings?.glassBorderOpacity ?? 0.12,
        refraction: settings?.glassRefraction ?? 20,
        saturate: settings?.glassSaturate ?? 1.8,
        highlightOpacity: settings?.glassHighlightOpacity ?? 0.15,
      },
    });
  } catch { res.status(500).json({ error: '获取玻璃设置失败' }); }
});

router.put('/glass', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { enabled, blur, opacity, borderOpacity, refraction, saturate, highlightOpacity } = req.body;
    await prisma.userSetting.upsert({
      where: { userId: req.user!.id },
      update: {
        glassEnabled: enabled,
        glassBlur: blur, glassOpacity: opacity, glassBorderOpacity: borderOpacity,
        glassRefraction: refraction, glassSaturate: saturate, glassHighlightOpacity: highlightOpacity,
      },
      create: {
        userId: req.user!.id,
        glassEnabled: enabled,
        glassBlur: blur, glassOpacity: opacity, glassBorderOpacity: borderOpacity,
        glassRefraction: refraction, glassSaturate: saturate, glassHighlightOpacity: highlightOpacity,
      },
    });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '更新玻璃设置失败' }); }
});

router.post('/model-pool', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { pool } = req.body;
    await prisma.userSetting.upsert({
      where: { userId: req.user!.id },
      update: { autoModelPool: pool },
      create: { userId: req.user!.id, autoModelPool: pool },
    });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '更新模型池失败' }); }
});

router.post('/mode-preferences', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { preferences } = req.body;
    await prisma.userSetting.upsert({
      where: { userId: req.user!.id },
      update: { modeModelPreferences: preferences },
      create: { userId: req.user!.id, modeModelPreferences: preferences },
    });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '更新偏好失败' }); }
});

router.post('/glass', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { enabled, blur, opacity, borderOpacity, refraction, saturate, highlightOpacity } = req.body;
    await prisma.userSetting.upsert({
      where: { userId: req.user!.id },
      update: {
        glassEnabled: enabled,
        glassBlur: blur, glassOpacity: opacity, glassBorderOpacity: borderOpacity,
        glassRefraction: refraction, glassSaturate: saturate, glassHighlightOpacity: highlightOpacity,
      },
      create: {
        userId: req.user!.id,
        glassEnabled: enabled,
        glassBlur: blur, glassOpacity: opacity, glassBorderOpacity: borderOpacity,
        glassRefraction: refraction, glassSaturate: saturate, glassHighlightOpacity: highlightOpacity,
      },
    });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '更新玻璃设置失败' }); }
});

// ==================== User Usage ====================

// GET /api/settings/usage
router.get('/usage', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const days = parseInt(String(req.query.days)) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [traces, usages] = await Promise.all([
      prisma.requestTrace.findMany({
        where: { userId, createdAt: { gte: since }, status: { notIn: ['QUEUED'] } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          createdAt: true,
          selectedModel: true,
          mode: true,
          status: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          creditsCharged: true,
          durationMs: true,
          ttftMs: true,
          finishReason: true,
        },
      }),
      prisma.tokenUsage.findMany({
        where: { userId, createdAt: { gte: since } },
        select: {
          messageId: true,
          actualTotalTokens: true,
        },
      }),
    ]);

    // 只保留「真实 token 总数」一个口径：display* 与实际值已合并（见
    // services/billing/tokenBilling.ts 文件头），不再有放大后的展示值。
    // 原先这里还读 cacheHitTokens / cacheMissTokens 来算 cacheHitRate，
    // 但这两个字段**从未被任何代码写入**，永远是 0，所谓"缓存命中率"
    // 纯属装饰字段，已移除。
    const usageMap = new Map<string, typeof usages[0]>();
    for (const u of usages) {
      if (u.messageId) {
        usageMap.set(u.messageId, u);
      }
    }

    const totals = traces.reduce(
      (acc, t) => {
        const u = usageMap.get(t.id);
        // 真实 token：优先 TokenUsage 实统计，缺失时退回 RequestTrace
        const realTokens = u ? u.actualTotalTokens : (t.totalTokens || 0);
        return {
          totalTokens: acc.totalTokens + realTokens,
          totalCredits: acc.totalCredits + (t.creditsCharged || 0),
          totalRequests: acc.totalRequests + 1,
          successCount: acc.successCount + (t.status === 'SUCCESS' ? 1 : 0),
        };
      },
      { totalTokens: 0, totalCredits: 0, totalRequests: 0, successCount: 0 },
    );

    const successRate = totals.totalRequests > 0 ? (totals.successCount / totals.totalRequests) : null;

    res.json({
      period: `${days} days` + ' usage',
      totals: {
        ...totals,
        successRate,
      },
      traces: traces.map((t) => {
        const u = usageMap.get(t.id);
        const realTokens = u ? u.actualTotalTokens : (t.totalTokens || 0);
        return {
          traceId: t.id,
          time: t.createdAt,
          model: t.selectedModel,
          mode: t.mode,
          status: t.status,
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
          totalTokens: realTokens,
          credits: t.creditsCharged,
          durationMs: t.durationMs,
          ttftMs: t.ttftMs,
        };
      }),
    });
  } catch (err) {
    console.error('User usage error:', err);
    res.status(500).json({ error: '获取使用记录失败' });
  }
});

export default router;