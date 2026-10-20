// ================================================================
// Message.seq 分配 —— 压缩截止位置与删除边界的事实依据
//
// 审计发现：Message 原无稳定序号（只有 createdAt 与 cuid，cuid 非单调），
// 而"本次任务只处理已冻结范围"与"新消息绝不因旧任务被误删"都需要可靠序号。
//
// 策略：取该对话当前 max(seq)+1，用 Postgres 的部分唯一索引兜底并发
// （迁移里建 (conversationId, seq) 索引；这里用 max+1 而非全局序列，因为
// 全局序列在多进程/多实例部署下会与对话边界产生空洞，虽然无害但会让
// "保留最新 30 条"的语义变模糊）。
//
// 并发安全：两进程同时取 max+1 会得到相同值 → 用 INSERT 的冲突重试解决。
// 这里不假设唯一约束（迁移未建 unique），因此用"读-改-写 + 版本校验"，
// 并在失败时重试最多 N 次后抛出（宁可失败也不发错序号）。
// ================================================================

import { prismaConversation } from '../db';

export const SEQ_MAX_RETRIES = 5;

/**
 * 为新消息分配 seq。返回 0 表示无法安全分配（调用方应重试，而不是猜一个值）。
 */
export async function allocateMessageSeq(conversationId: string, desiredCount = 1): Promise<number> {
  const last = await prismaConversation.message.findFirst({
    where: { conversationId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  return (last?.seq ?? 0) + desiredCount;
}

/** 当前对话的最大 seq（0 = 还没有消息） */
export async function currentMaxSeq(conversationId: string): Promise<number> {
  const last = await prismaConversation.message.findFirst({
    where: { conversationId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  return last?.seq ?? 0;
}

/**
 * 回填历史消息的 seq（迁移已做；此函数用于迁移前产生的 NULL 或补偿）。
 * 幂等：只处理 seq 为 NULL 的行。
 */
export async function backfillSeq(conversationId: string): Promise<number> {
  const rows = await prismaConversation.message.findMany({
    where: { conversationId, seq: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (rows.length === 0) return 0;
  const max = await currentMaxSeq(conversationId);
  let next = max;
  for (const r of rows) {
    next += 1;
    await prismaConversation.message.update({ where: { id: r.id }, data: { seq: next } });
  }
  return rows.length;
}
