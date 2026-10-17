import { Router, Response } from 'express';
import { prismaKnowledge } from '../services/db';
import { authMiddleware, adminAuth, AuthRequest } from '../middleware/auth';
import { prismaUser } from '../services/db';

const router = Router();

// ==================== Knowledge Folders ====================

router.get('/folders', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const folders = await prismaKnowledge.knowledgeFolder.findMany({
      include: { _count: { select: { entries: true } } },
      orderBy: { name: 'asc' },
    });
    res.json({ folders });
  } catch { res.status(500).json({ error: '获取知识库文件夹失败' }); }
});

router.post('/folders', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { name } = req.body;
    if (!name) { res.status(400).json({ error: '文件夹名称不能为空' }); return; }
    const folder = await prismaKnowledge.knowledgeFolder.create({ data: { name: String(name) } });
    res.json({ folder });
  } catch { res.status(500).json({ error: '创建文件夹失败' }); }
});

router.delete('/folders/:id', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await prismaKnowledge.knowledgeFolder.delete({ where: { id: String(req.params.id) } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '删除文件夹失败' }); }
});

// ==================== Knowledge Entries ====================

router.get('/entries', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { category, folderId, search, page, limit } = req.query;
    const where: any = { isActive: true };
    if (category) where.category = String(category);
    if (folderId) where.folderId = String(folderId);
    if (search) where.OR = [
      { title: { contains: String(search) } },
      { content: { contains: String(search) } },
    ];

    const take = parseInt(String(limit)) || 20;
    const skip = ((parseInt(String(page)) || 1) - 1) * take;

    const [entries, total] = await Promise.all([
      prismaKnowledge.knowledgeBase.findMany({ where, skip, take, orderBy: { updatedAt: 'desc' }, include: { folder: true } }),
      prismaKnowledge.knowledgeBase.count({ where }),
    ]);

    res.json({ entries, total, page: parseInt(String(page)) || 1, pages: Math.ceil(total / take) });
  } catch { res.status(500).json({ error: '获取知识条目失败' }); }
});

router.post('/entries', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { title, content, category, evidenceLevel, region, product, version, source, folderId } = req.body;
    const entry = await prismaKnowledge.knowledgeBase.create({
      data: { title, content, category, evidenceLevel, region, product, version, source, folderId },
    });

    if (content) {
      const chunks = splitIntoChunks(content, 500);
      for (const chunk of chunks) {
        await prismaKnowledge.documentChunk.create({
          data: { sourceId: entry.id, sourceType: 'knowledge_base', content: chunk, title: entry.title },
        }).catch(() => {});
      }
    }

    res.json({ entry });
  } catch { res.status(500).json({ error: '创建知识条目失败' }); }
});

router.delete('/entries/:id', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await prismaKnowledge.knowledgeBase.update({ where: { id: String(req.params.id) }, data: { isActive: false } });
    await prismaKnowledge.documentChunk.updateMany({ where: { sourceId: String(req.params.id) }, data: { isActive: false } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '删除知识条目失败' }); }
});

// ==================== Skills ====================

router.get('/skills', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const skills = await prismaKnowledge.skill.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    res.json({ skills });
  } catch { res.status(500).json({ error: '获取技能失败' }); }
});

router.post('/skills', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, prompt, category } = req.body;
    const skill = await prismaKnowledge.skill.create({ data: { name, description, prompt, category } });
    // Admin-origin create is the only legal formal-Skill path (SkillPublishGuard).
    // Enqueue S1 semantic analysis; S1 enriches metadata only, never the prompt.
    const { guardSkillPublication, enqueueSkillAnalysis } = await import('../services/skillPublishGuard');
    const guard = guardSkillPublication({ origin: 'admin_route', actorId: req.user?.id });
    if (!guard.allowed) {
      // Should not happen for admin route, but be defensive.
      res.status(403).json({ error: guard.reason });
      return;
    }
    await enqueueSkillAnalysis(skill.id, 'uploaded', req.user?.id).catch(() => undefined);
    res.json({ skill, analysisEnqueued: true });
  } catch { res.status(500).json({ error: '创建技能失败' }); }
});

router.put('/skills/:id', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const skill = await prismaKnowledge.skill.update({ where: { id: String(req.params.id) }, data: req.body });
    // Content change => re-enqueue S1 (version bump + re-analysis).
    const { guardSkillPublication, enqueueSkillAnalysis } = await import('../services/skillPublishGuard');
    const guard = guardSkillPublication({ origin: 'admin_route', actorId: req.user?.id });
    if (guard.allowed) {
      await enqueueSkillAnalysis(skill.id, 'updated', req.user?.id).catch(() => undefined);
    }
    res.json({ skill, analysisEnqueued: guard.allowed });
  } catch { res.status(500).json({ error: '更新技能失败' }); }
});

// ==================== Legal Rules ====================

router.get('/rules', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { region, category } = req.query;
    const where: any = {};
    if (region) where.region = String(region);
    if (category) where.category = String(category);
    const rules = await prismaKnowledge.legalRule.findMany({ where });
    res.json({ rules });
  } catch { res.status(500).json({ error: '获取规则失败' }); }
});

// ==================== Knowledge Research ====================
// Dynamically import to avoid circular deps
const researchService = () => import('../services/researchManager');
const runtimeService = () => import('../services/knowledgeRuntime');
const executorService = () => import('../services/researchExecutor');
const plannerService = () => import('../services/researchPlanner');

// Build a Planner-backed planJson for a manual /research/trigger job.
// Falls back to the legacy { objectType, region, queries } shape when the
// Planner or lookups are unavailable, preserving historical API behavior.
async function buildTriggerPlanJson(
  objectType: string,
  objectName: string,
  region?: string,
): Promise<string> {
  try {
    const planner = await plannerService();
    let existingFacts: any[] = [];
    try {
      const obj = await prismaKnowledge.knowledgeObject.findFirst({
        where: { canonicalName: { contains: objectName } },
        take: 1,
      });
      if (obj) {
        existingFacts = await prismaKnowledge.knowledgeFact.findMany({
          where: { objectId: obj.id, lifecycleStatus: 'ACTIVE' },
          select: { claimType: true },
          take: 200,
        });
      }
    } catch { /* facts unavailable — plan without coverage context */ }

    const plan = await planner.planResearch(
      { objectType, title: objectName, canonicalName: objectName },
      null,
      existingFacts,
      region ? { region } : undefined,
    );
    return JSON.stringify({
      ...(plan as unknown as Record<string, unknown>),
      queries: plan.searchQueries,
      objectType: objectName,
      region,
      plannedAt: new Date().toISOString(),
    });
  } catch {
    // Legacy minimal plan (still executable by the compat reader).
    return JSON.stringify({ objectType: objectName, region, queries: [objectName] });
  }
}

router.post('/research/trigger', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { objectType, objectName, region, variantId, triggerMode } = req.body;
    if (!objectType || !objectName) { res.status(400).json({ error: 'objectType and objectName required' }); return; }

    const mgr = await researchService();
    const jobType = (triggerMode === 'foreground') ? 'ON_DEMAND' : 'BACKGROUND';
    // Planner-backed planJson: produce a full ResearchPlan for the object;
    // degrade to the legacy { objectType, region, queries } shape if the
    // Planner or object lookup is unavailable, keeping API behavior intact.
    const planJson = await buildTriggerPlanJson(objectType, objectName, region);
    const jobId = await mgr.createResearchJob(objectType, variantId || null, jobType, 5, planJson);

    if (triggerMode === 'foreground') {
      // Atomically claim the job so the worker pool cannot double-execute it.
      const claimed = await mgr.claimResearchJobForForeground(jobId);
      if (!claimed) {
        const job = await mgr.findResearchJob(jobId);
        res.json({ jobId, status: job?.status || 'QUEUED', result: null });
        return;
      }
      const executor = await executorService();
      await executor.executeResearchJob(jobId);
      const job = await mgr.findResearchJob(jobId);
      res.json({ jobId, status: job?.status, result: job?.resultJson });
    } else {
      res.json({ jobId, status: 'QUEUED' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Research trigger failed' });
  }
});

router.get('/research/jobs', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { objectId, status, page, limit } = req.query;
    const where: any = {};
    if (objectId) where.objectId = String(objectId);
    if (status) where.status = String(status);

    const take = parseInt(String(limit)) || 20;
    const skip = ((parseInt(String(page)) || 1) - 1) * take;

    const [jobs, total] = await Promise.all([
      prismaUser.researchJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prismaUser.researchJob.count({ where }),
    ]);
    res.json({ jobs, total, page: parseInt(String(page)) || 1 });
  } catch { res.status(500).json({ error: '获取研究任务失败' }); }
});

router.get('/research/queues', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const mgr = await researchService();
    const queues = await mgr.listQueues();
    res.json({ queues });
  } catch { res.status(500).json({ error: '获取队列失败' }); }
});

// ==================== Self-Organization ====================
// Organizes existing knowledge base content only. Never researches.

const orgRuntime = () => import('../services/knowledgeOrg/orgRuntime');

router.post('/organization/trigger', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { scopeType, scopeId, objectId, triggerReason, triggerMode, priority } = req.body;
    if (!scopeType || !scopeId) {
      res.status(400).json({ error: 'scopeType and scopeId required' });
      return;
    }
    const valid = ['object', 'variant', 'version', 'category', 'subtree'];
    if (!valid.includes(scopeType)) {
      res.status(400).json({ error: `scopeType must be one of: ${valid.join(', ')}` });
      return;
    }
    const runtime = await orgRuntime();
    const { jobId, reused } = await runtime.createOrganizationJob(
      scopeType,
      scopeId,
      String(triggerReason ?? 'MANUAL'),
      objectId ? String(objectId) : undefined,
      priority ? parseInt(String(priority), 10) : 5,
    );

    if (triggerMode === 'foreground') {
      const execution = await runtime.executeOrganizationJob(jobId);
      const job = await runtime.findOrganizationJob(jobId);
      res.json({ jobId, reused, status: execution.status, result: job?.resultJson });
    } else {
      res.json({ jobId, reused, status: 'QUEUED' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Organization trigger failed' });
  }
});

router.get('/organization/jobs', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { status, scopeType, page, limit } = req.query;
    const where: any = {};
    if (status) where.status = String(status);
    if (scopeType) where.scopeType = String(scopeType);

    const take = parseInt(String(limit)) || 20;
    const skip = ((parseInt(String(page)) || 1) - 1) * take;

    const [jobs, total] = await Promise.all([
      prismaUser.organizationJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prismaUser.organizationJob.count({ where }),
    ]);
    res.json({ jobs, total, page: parseInt(String(page)) || 1 });
  } catch { res.status(500).json({ error: '获取整理任务失败' }); }
});

router.get('/organization/records', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { scopeType, scopeId, page, limit } = req.query;
    const where: any = {};
    if (scopeType) where.scopeType = String(scopeType);
    if (scopeId) where.scopeId = String(scopeId);

    const take = parseInt(String(limit)) || 20;
    const skip = ((parseInt(String(page)) || 1) - 1) * take;

    const [records, total] = await Promise.all([
      prismaKnowledge.organizationRecord.findMany({ where, orderBy: { appliedAt: 'desc' }, skip, take }),
      prismaKnowledge.organizationRecord.count({ where }),
    ]);
    res.json({ records, total, page: parseInt(String(page)) || 1 });
  } catch { res.status(500).json({ error: '获取整理记录失败' }); }
});

router.get('/organization/records/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const record = await prismaKnowledge.organizationRecord.findUnique({ where: { id: String(req.params.id) } });
    if (!record) { res.status(404).json({ error: 'Record not found' }); return; }
    res.json({ record });
  } catch { res.status(500).json({ error: '获取整理记录失败' }); }
});

// ==================== Helper ====================

function splitIntoChunks(text: string, maxLen: number): string[] {
  const sentences = text.split(/(?<=[。.!！?？\n])/);
  const chunks: string[] = [];
  let current = '';
  for (const s of sentences) {
    if (current.length + s.length > maxLen && current) {
      chunks.push(current.trim());
      current = '';
    }
    current += s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text.substring(0, maxLen)];
}

export default router;