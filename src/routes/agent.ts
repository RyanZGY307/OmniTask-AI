import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { prismaEventStore, agentPrisma } from '../events/prismaEventStore';
import type { EventType, EventLevel } from '../events/types';

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

// GET /api/agent/events/:runId - 获取某 Run 的事件（用于历史回放）
router.get('/events/:runId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
    const afterSeq = req.query.afterSeq ? parseInt(req.query.afterSeq as string, 10) : undefined;

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
router.get('/events/:runId/stream', authMiddleware, async (req: Request, res: Response) => {
  const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;

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
router.get('/tasks/:taskId/runs', authMiddleware, async (req: Request, res: Response) => {
  try {
    const taskId = Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId;
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

export default router;