// Prisma/Postgres 实现的 EventStore（agent 专用，落 agent 库）
// 契约：src/events/types.ts 的 EventStore 接口
// 设计：agent 事件独立存 agent 库（schema-agent.prisma 的 Event 模型），与宿主 4 库分离

import { PrismaClient as AgentPrismaClient } from '@prisma/client-agent';
import type { EventStore, AgentEvent, EventDraft, EventType, EventLevel } from './types';
import type { InputJsonValue } from '@prisma/client-agent/runtime/library';

const prisma = new AgentPrismaClient();

function mapRow(row: any): AgentEvent {
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    type: row.type as EventType,
    level: row.level as EventLevel,
    ts: row.ts.toISOString(),
    payload: row.payload as Record<string, unknown>,
  };
}

function toJson(value: Record<string, unknown>): InputJsonValue {
  return value as InputJsonValue;
}

export const prismaEventStore: EventStore = {
  async append(runId: string, draft: EventDraft): Promise<AgentEvent> {
    const last = await prisma.event.findFirst({
      where: { runId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    const seq = (last?.seq ?? -1) + 1;
    const now = new Date();
    const created = await prisma.event.create({
      data: {
        runId,
        seq,
        type: draft.type,
        level: draft.level ?? 'info',
        payload: toJson(draft.payload),
        ts: draft.ts ? new Date(draft.ts) : now,
      },
    });
    return mapRow(created);
  },

  async appendBatch(runId: string, drafts: EventDraft[]): Promise<AgentEvent[]> {
    if (drafts.length === 0) return [];
    const last = await prisma.event.findFirst({
      where: { runId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    let seq = (last?.seq ?? -1) + 1;
    const now = new Date();
    const results: AgentEvent[] = [];
    for (const draft of drafts) {
      const created = await prisma.event.create({
        data: {
          runId,
          seq: seq++,
          type: draft.type,
          level: draft.level ?? 'info',
          payload: toJson(draft.payload),
          ts: draft.ts ? new Date(draft.ts) : now,
        },
      });
      results.push(mapRow(created));
    }
    return results;
  },

  async getEvents(runId: string, afterSeq?: number): Promise<AgentEvent[]> {
    const events = await prisma.event.findMany({
      where: {
        runId,
        ...(afterSeq !== undefined ? { seq: { gt: afterSeq } } : {}),
      },
      orderBy: { seq: 'asc' },
    });
    return events.map(mapRow);
  },

  async lastSeq(runId: string): Promise<number> {
    const last = await prisma.event.findFirst({
      where: { runId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    return last?.seq ?? -1;
  },
};

// 供外部引用（如 AgentLoop 注入）
export { prisma as agentPrisma };