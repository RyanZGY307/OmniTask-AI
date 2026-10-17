// ================================================================
// User Skill Routes — install a skill from a link onto the caller's
// own account (isolated), list / uninstall mine, browse the global pool.
//
// Mounted at /api/skills. All endpoints require auth; every write is
// scoped to req.user.id — an account can only see and manage its own
// installs. Cross-account visibility is admin-only (skillRoster).
// ================================================================

import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import {
  installUserSkillFromUrl,
  listUserSkills,
  uninstallUserSkill,
} from '../services/userSkillInstall';
import { prismaKnowledge } from '../services/db';

const router = Router();
router.use(authMiddleware);

/** POST /api/skills/install { url } — install a skill from a link. */
router.post('/install', async (req: AuthRequest, res: Response) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url is required' });
    const result = await installUserSkillFromUrl(req.user!.id, url);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ...result });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Install failed' });
  }
});

/** GET /api/skills/my — this account's installed skills. */
router.get('/my', async (req: AuthRequest, res: Response) => {
  try {
    const skills = await listUserSkills(req.user!.id);
    res.json({ skills });
  } catch {
    res.status(500).json({ error: 'Failed to list skills' });
  }
});

/** DELETE /api/skills/my/:id — uninstall one of this account's skills. */
router.delete('/my/:id', async (req: AuthRequest, res: Response) => {
  try {
    const res2 = await uninstallUserSkill(req.user!.id, String(req.params.id));
    if (res2.count === 0) return res.status(404).json({ error: 'Skill not found' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to uninstall' });
  }
});

/** GET /api/skills/available — the global pool (browse before promoting). */
router.get('/available', async (_req: AuthRequest, res: Response) => {
  try {
    const skills = await prismaKnowledge.skill.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    res.json({ skills });
  } catch {
    res.status(500).json({ error: 'Failed to list global skills' });
  }
});

export default router;
