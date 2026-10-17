import { Router, Response } from 'express';
import { prisma } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getAdaptiveProfile } from '../services/userMemory';
import { getDomainProfiles } from '../services/domainKnowledge';
import { getLanguageProfiles } from '../services/languageLearning';

const router = Router();

// ===== Adaptive Profile =====

router.get('/adaptive', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const profile = await getAdaptiveProfile(req.user!.id);
    res.json({ profile });
  } catch { res.status(500).json({ error: '获取画像失败' }); }
});

// ===== Preferences =====

router.get('/preferences', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const prefs = await prisma.userPreference.findMany({
      where: { userId: req.user!.id, status: { in: ['active', 'superseded'] } },
      orderBy: { lastObservedAt: 'desc' },
    });
    res.json({ preferences: prefs });
  } catch { res.status(500).json({ error: '获取偏好失败' }); }
});

router.put('/preferences/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const pref = await prisma.userPreference.findUnique({ where: { id: String(req.params.id) } });
    if (!pref || pref.userId !== req.user!.id) return res.status(404).json({ error: '偏好不存在' });
    const updated = await prisma.userPreference.update({ where: { id: pref.id }, data: req.body });
    res.json({ preference: updated });
  } catch { res.status(500).json({ error: '更新偏好失败' }); }
});

router.delete('/preferences/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const pref = await prisma.userPreference.findUnique({ where: { id: String(req.params.id) } });
    if (!pref || pref.userId !== req.user!.id) return res.status(404).json({ error: '偏好不存在' });
    await prisma.userPreference.update({ where: { id: pref.id }, data: { status: 'archived' } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '删除偏好失败' }); }
});

// ===== Requirements =====

router.get('/requirements', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const reqs = await prisma.userRequirement.findMany({
      where: { userId: req.user!.id, status: 'active' },
      orderBy: { priority: 'desc' },
    });
    res.json({ requirements: reqs });
  } catch { res.status(500).json({ error: '获取要求失败' }); }
});

router.post('/requirements', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { category, content, priority } = req.body;
    const requirement = await prisma.userRequirement.create({
      data: { userId: req.user!.id, category, content, priority: priority || 'normal', source: 'explicit' },
    });
    res.json({ requirement });
  } catch { res.status(500).json({ error: '创建要求失败' }); }
});

router.delete('/requirements/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const req_ = await prisma.userRequirement.findUnique({ where: { id: String(req.params.id) } });
    if (!req_ || req_.userId !== req.user!.id) return res.status(404).json({ error: '要求不存在' });
    await prisma.userRequirement.update({ where: { id: req_.id }, data: { status: 'disabled' } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '删除要求失败' }); }
});

// ===== Domain Knowledge =====

router.get('/domains', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const domains = await getDomainProfiles(req.user!.id);
    res.json({ domains });
  } catch { res.status(500).json({ error: '获取领域知识失败' }); }
});

router.get('/domains/:domain', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const domain = await prisma.domainProfile.findUnique({
      where: { userId_domain: { userId: req.user!.id, domain: String(req.params.domain) } },
      include: { subdomains: true, evidences: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    if (!domain) return res.status(404).json({ error: '领域不存在' });
    res.json({ domain });
  } catch { res.status(500).json({ error: '获取领域详情失败' }); }
});

// ===== Language Profiles =====

router.get('/languages', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const languages = await getLanguageProfiles(req.user!.id);
    res.json({ languages });
  } catch { res.status(500).json({ error: '获取语言能力失败' }); }
});

router.get('/languages/:language', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const profile = await prisma.languageProfile.findUnique({
      where: { userId_language: { userId: req.user!.id, language: String(req.params.language) } },
      include: { skills: true, vocabularies: { where: { status: 'known' }, take: 50 }, preferences: true },
    });
    if (!profile) return res.status(404).json({ error: '语言档案不存在' });
    res.json({ profile });
  } catch { res.status(500).json({ error: '获取语言详情失败' }); }
});

// ===== Habits =====

router.get('/habits', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const habits = await prisma.userHabit.findMany({
      where: { userId: req.user!.id, status: { in: ['active', 'validating', 'candidate'] } },
      orderBy: { confidence: 'desc' },
    });
    res.json({ habits });
  } catch { res.status(500).json({ error: '获取习惯失败' }); }
});

// ===== Interests =====

router.get('/interests', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const interests = await prisma.userInterest.findMany({
      where: { userId: req.user!.id, status: 'active' },
      orderBy: { strength: 'desc' },
    });
    res.json({ interests });
  } catch { res.status(500).json({ error: '获取兴趣失败' }); }
});

export default router;