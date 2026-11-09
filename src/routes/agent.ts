import { Router, Request, Response } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { prismaEventStore, agentPrisma } from '../agent/events/prismaEventStore';
import type { EventType, EventLevel } from '../agent/events/types';

const router = Router();

// Agent SSE 端点：复用宿主 SSE 通道，新增 agent_event 帧族与现有帧共存
// 帧格式：data: ${JSON.stringify({ type: 'agent_event', seq, eventType, payload })}\n\n
// 事件类型词表严格采用 src/events/types.ts 的 EVENT_TYPES（不增删改名）

const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'run.created','run.depth_decided','run.depth_switched','run.started','run.compacted','run.budget_exhausted','run.restored',
  'step.started','step.succeeded','step.failed','step.denied','step.skipped','step.timed_out',
  'model_call.started','model_call.finished','model_call.degraded',
  'tool.requested','tool.approved','tool.denied','tool.result','tool.replayed_skipped',
  'approval.requested','approval.decided','approval.expired',
  'user.input','userinput.requested','userinput.answered',
  'no_progress.detected','run.completed','run.failed','run.canceled',
  'pattern.selected','pattern.downgraded','pattern.switched','pattern.completed',
]);

const ALLOWED_LEVELS: ReadonlySet<EventLevel> = new Set(['info', 'warn', 'error']);

// ==================== 归属校验（阶段0止血 R-6001/R-6002/R-6003）====================
// 问题：此前本文件的 run/approval 端点只校验"已登录"，不校验"是否属于你"，
// 于是任何账号都能读他人 run、篡改他人审计事件、代替他人批准 r2/r3 操作。
// 归属链：Run.taskId → Task.userId（Task.userId 由 startRun 在创建 task 时写入）。
// 管理员（ADMIN/SUPER_ADMIN）放行——运维排障需要跨用户查看，这部分是显式授权而非漏洞。
type RunAccess = 'ok' | 'notfound' | 'forbidden';

async function canAccessRun(req: AuthRequest, runId: string): Promise<RunAccess> {
  const uid = req.user?.id;
  if (!uid) return 'notfound';
  const run = await agentPrisma.run.findUnique({
    where: { id: runId },
    select: { task: { select: { userId: true } } },
  });
  if (!run) return 'notfound';
  const role = req.user?.role;
  if (role === 'ADMIN' || role === 'SUPER_ADMIN') return 'ok';
  return run.task?.userId === uid ? 'ok' : 'forbidden';
}

async function canAccessApproval(req: AuthRequest, approvalId: string): Promise<RunAccess> {
  const ap = getApprovalService().get(approvalId);
  if (!ap) return 'notfound';
  return canAccessRun(req, ap.runId);
}

function accessDenied(access: RunAccess): { status: number; error: string } {
  if (access === 'forbidden') return { status: 403, error: '无权访问该资源' };
  return { status: 404, error: '资源不存在' };
}

// GET /api/agent/events/:runId - 获取某 Run 的事件（用于历史回放）
router.get('/events/:runId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
    const afterSeq = req.query.afterSeq ? parseInt(req.query.afterSeq as string, 10) : undefined;

    // 归属校验：事件流含任务细节与工具参数，非属主不得读（R-6003 同类）
    const access = await canAccessRun(req, runId);
    if (access !== 'ok') {
      const { status, error } = accessDenied(access);
      return res.status(status).json({ error });
    }

    const events = await prismaEventStore.getEvents(runId, afterSeq);
    res.json({ events });
  } catch (err: any) {
    console.error('[agent/events] error:', err);
    res.status(500).json({ error: '获取事件失败', detail: err?.message ?? String(err) });
  }
});

// GET /api/agent/events/:runId/stream - SSE 实时推送（agent_event 帧族）
// 与现有 chat SSE 共存：现有帧 type='accepted'/'error'/'chunk' 等不变
// 新增 agent_event 帧：{ type: 'agent_event', seq, eventType, payload }
router.get('/events/:runId/stream', authMiddleware, async (req: AuthRequest, res: Response) => {
  const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;

  // 归属校验：SSE 长连接先做异步权限判断，再写任何头。
  // 顺序很重要——若先 writeHead 就只能在断开连接时表达拒绝，前端无法区分
  // "无权限"与"流结束"，而且已泄漏 200 状态码。
  const access = await canAccessRun(req, runId);
  if (access !== 'ok') {
    const { status, error } = accessDenied(access);
    return res.status(status).json({ error });
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
  });

  const safeWrite = (payload: string): void => {
    if (clientDisconnected || res.destroyed || res.writableEnded) return;
    try { res.write(payload); } catch { clientDisconnected = true; }
  };

  // 发送初始连接确认（宿主既有格式）
  safeWrite(`data: ${JSON.stringify({ type: 'agent_stream_connected', runId })}\n\n`);

  // 从当前水位开始轮询新事件（简单实现：每 500ms 轮询；生产可改用 LISTEN/NOTIFY 或消息队列）
  let lastSeq = -1;
  const pollInterval = setInterval(async () => {
    if (clientDisconnected) {
      clearInterval(pollInterval);
      return;
    }
    try {
      const events = await prismaEventStore.getEvents(runId, lastSeq);
      for (const event of events) {
        if (clientDisconnected) break;
        lastSeq = event.seq;
        // 发送 agent_event 帧（data: 格式，与现有 chat SSE 共存）
        safeWrite(`data: ${JSON.stringify({
          type: 'agent_event',
          seq: event.seq,
          eventType: event.type,
          payload: event.payload,
          level: event.level,
          ts: event.ts,
        })}\n\n`);
      }
    } catch (err) {
      console.error('[agent/stream] poll error:', err);
    }
  }, 500);

  // 连接关闭时清理
  req.on('close', () => {
    clearInterval(pollInterval);
  });
});

// POST /api/agent/events/:runId - 追加事件（内部/测试用）
router.post('/events/:runId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
    const { type, level, payload } = req.body as { type?: string; level?: string; payload?: Record<string, unknown> };

    if (!type) {
      return res.status(400).json({ error: '缺少 type 字段' });
    }

    // 归属校验：事件即审计证据，非属主不得向他人 run 注入事件（R-6001）
    const access = await canAccessRun(req, runId);
    if (access !== 'ok') {
      const { status, error } = accessDenied(access);
      return res.status(status).json({ error });
    }

    if (!ALLOWED_TYPES.has(type)) {
      return res.status(400).json({ error: '非法 type 字段' });
    }
    const evtLevel: EventLevel = (level && ALLOWED_LEVELS.has(level as EventLevel)) ? (level as EventLevel) : 'info';

    const event = await prismaEventStore.append(runId, { 
      type: type as EventType, 
      level: evtLevel, 
      payload: (payload ?? {}) as Record<string, unknown>,
      runId  // EventDraft requires runId
    });
    res.json({ event });
  } catch (err: any) {
    console.error('[agent/events POST] error:', err);
    res.status(500).json({ error: '追加事件失败', detail: err?.message ?? String(err) });
  }
});

// GET /api/agent/tasks/:taskId/runs - 获取任务的所有 run（用于 UI 列表）
router.get('/tasks/:taskId/runs', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
    // 归属校验：按 task 列 run 同样泄露他人任务（R-6003 同类）
    const task = await agentPrisma.task.findUnique({ where: { id: taskId }, select: { userId: true } });
    if (!task) return res.status(404).json({ error: 'task 不存在' });
    const isAdmin = req.user?.role === 'ADMIN' || req.user?.role === 'SUPER_ADMIN';
    if (!isAdmin && task.userId !== req.user!.id) {
      return res.status(403).json({ error: '无权访问该资源' });
    }
    const runs = await agentPrisma.run.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        state: true,
        modelTier: true,
        depth: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { steps: true, events: true } },
      },
    });
    res.json({ runs });
  } catch (err: any) {
    console.error('[agent/tasks/runs] error:', err);
    res.status(500).json({ error: '获取 runs 失败', detail: err?.message ?? String(err) });
  }
});

// ===== S5 UI 数据面：列表/详情一律由「事件流」服务端投影（唯一事实源纪律） =====
// taskView 的 projectTaskCard/toEventRows 在服务端运行，前端只渲染 VM 字段，不得另存状态。
import { projectTaskCard, toEventRows } from '../agent/ui/taskView';
import { getAgentLoop, getApprovalService, startRun, decideApproval, isRunning } from '../agent/runtime/hostRuntime';

// GET /api/agent/runs?taskId=&limit= - 任务列表：Run 行 + 每个 run 的卡片 VM（由事件折叠）
router.get('/runs', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const taskId = req.query.taskId as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const isAdmin = req.user?.role === 'ADMIN' || req.user?.role === 'SUPER_ADMIN';
    const uid = req.user!.id;

    // 不指定 taskId 时按属主过滤：非管理员只能看到自己的 run（R-6003）。
    // 指定 taskId 时先单独校验该 task 归属，防止用 taskId 绕过属主过滤。
    let where: Record<string, unknown> = {};
    if (taskId) {
      const task = await agentPrisma.task.findUnique({ where: { id: taskId }, select: { userId: true } });
      if (!task) return res.status(404).json({ error: 'task 不存在' });
      if (!isAdmin && task.userId !== uid) return res.status(403).json({ error: '无权访问该资源' });
      where = { taskId };
    } else if (!isAdmin) {
      where = { task: { userId: uid } };
    }

    const runs = await agentPrisma.run.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, taskId: true, state: true, modelTier: true, depth: true, createdAt: true, updatedAt: true },
    });
    const cards = await Promise.all(
      runs.map(async (r) => {
        const events = await prismaEventStore.getEvents(r.id).catch(() => []);
        return { runId: r.id, card: projectTaskCard(events) };
      }),
    );
    res.json({ runs, cards, running: runs.filter((r) => isRunning(r.id)).map((r) => r.id) });
  } catch (err: any) {
    console.error('[agent/runs] error:', err);
    res.status(500).json({ error: '获取 run 列表失败', detail: err?.message ?? String(err) });
  }
});

// GET /api/agent/runs/:runId - 详情：Run 行 + 卡片 VM + 事件行（人话摘要）
router.get('/runs/:runId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
    const run = await agentPrisma.run.findUnique({ where: { id: runId } });
    if (!run) return res.status(404).json({ error: 'run 不存在' });
    // 归属校验：非属主与非管理员一律 403，防止越权读取他人任务细节（R-6003）
    const access = await canAccessRun(req, runId);
    if (access !== 'ok') {
      const { status, error } = accessDenied(access);
      return res.status(status).json({ error });
    }
    const events = await prismaEventStore.getEvents(runId);
    res.json({
      run,
      card: projectTaskCard(events),
      eventRows: toEventRows(events),
      pendingApprovals: getApprovalService().pendingFor(runId).map((a) => ({
        id: a.id, summary: a.summary, riskLevel: a.riskLevel, state: a.state, toolFingerprint: a.toolFingerprint,
      })),
      running: isRunning(runId),
    });
  } catch (err: any) {
    console.error('[agent/runs/:id] error:', err);
    res.status(500).json({ error: '获取 run 详情失败', detail: err?.message ?? String(err) });
  }
});

// POST /api/agent/runs - 建任务（可选）+ run 并后台启动
router.post('/runs', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { taskId, conversationId, objective, userMessage, workspaceRoots, tier } = req.body ?? {};
    if (!objective || !userMessage) return res.status(400).json({ error: '缺少 objective/userMessage' });
    const started = await startRun({ taskId, conversationId, userId, objective, userMessage, workspaceRoots, tier });
    res.json(started);
  } catch (err: any) {
    console.error('[agent/runs POST] error:', err);
    res.status(500).json({ error: '创建 run 失败', detail: err?.message ?? String(err) });
  }
});

// POST /api/agent/runs/:runId/start - 对已有 Run 行重启（幂等：running 中直接 409）
router.post('/runs/:runId/start', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
    if (isRunning(runId)) return res.status(409).json({ error: 'run 正在执行中' });
    const run = await agentPrisma.run.findUnique({ where: { id: runId } });
    if (!run) return res.status(404).json({ error: 'run 不存在' });
    // 归属校验：非属主不得重启他人 run（重启会消耗算力并可能改变任务状态）
    const access = await canAccessRun(req, runId);
    if (access !== 'ok') {
      const { status, error } = accessDenied(access);
      return res.status(status).json({ error });
    }
    const task = await agentPrisma.task.findUnique({ where: { id: run.taskId } });
    const started = await startRun({
      taskId: run.taskId,
      conversationId: task?.conversationId ?? undefined,
      userId: req.user!.id,
      objective: task?.objective ?? '',
      userMessage: task?.objective ?? '',
      tier: 'pro',
    });
    res.json(started);
  } catch (err: any) {
    console.error('[agent/runs/:id/start] error:', err);
    res.status(500).json({ error: '启动 run 失败', detail: err?.message ?? String(err) });
  }
});

// POST /api/agent/approvals/:approvalId/decide - 人工审批决定（by=登录用户，红线：必须是人类）
// body: { decision: 'approved' | 'denied' }
router.post('/approvals/:approvalId/decide', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const approvalId = Array.isArray(req.params.approvalId) ? req.params.approvalId[0] : req.params.approvalId;
    const { decision } = req.body ?? {};
    if (decision !== 'approved' && decision !== 'denied') {
      return res.status(400).json({ error: "decision 必须是 approved|denied" });
    }
    // 归属校验：审批是风险放行闸门，非属主不得替他人批准 r2/r3 操作（R-6002）
    const access = await canAccessApproval(req, approvalId);
    if (access !== 'ok') {
      const { status, error } = accessDenied(access);
      return res.status(status).json({ error });
    }
    const by = req.user!.id; // 人类 userId，桥接层事件 approval.decided.by = by
    const r = await decideApproval(approvalId, decision, by);
    if (!r.ok) return res.status(400).json({ error: r.reason });
    res.json(r);
  } catch (err: any) {
    console.error('[agent/approvals/decide] error:', err);
    res.status(500).json({ error: '审批失败', detail: err?.message ?? String(err) });
  }
});

// GET /api/agent/capabilities - S6 能力面开关：五布尔如实来自 AgentLoop.capabilities()，未注入=不可用不伪造
router.get('/capabilities', authMiddleware, async (_req: Request, res: Response) => {
  const caps = getAgentLoop().capabilities();
  res.json({ capabilities: caps, policyLoaded: getApprovalService().isPolicyLoaded?.() ?? true });
});

export default router;