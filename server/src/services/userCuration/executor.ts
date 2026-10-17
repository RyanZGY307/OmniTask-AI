// ================================================================
// Curation Executor — 后端执行层：验证 → 写库 → 审计
// ================================================================
// 模型只负责"提议"（candidates）。本层负责：
//   1. 每条提议按允许清单 + 业务规则做二次校验（schema.ts 已做结构层）；
//   2. 所有读写都带上「可信后端确定的 userId」，绝不使用模型输出中的用户标识；
//   3. 目标记录必须真实存在且属于该用户，否则降级为 review（不猜）；
//   4. 写入走既有数据表（UserPreference / UserRequirement / LongTermMemory），
//      多步写入用事务；LongTermMemory 变更写 MemoryEvent 审计；
//   5. SESSION/TEMPORARY/ARTIFACT/TASK 作用域不进长期表（已有各自的
//      会话/任务/成果存储），返回 skipped_scope，不伪装保存成功。
// ================================================================

import { prisma } from '../db';
import type { CurationCandidate, Category } from './schema';
import { looksLikeSecret } from './schema';

export interface OpOutcome {
  index: number;
  category: string;
  operation: string;
  key: string;
  /** saved / noop_duplicate / reinforced / skipped_scope / rejected_sensitive / review_target_not_found / review / failed */
  status: 'saved' | 'noop_duplicate' | 'reinforced' | 'skipped_scope' | 'rejected_sensitive' | 'review_target_not_found' | 'review' | 'failed' | 'noop';
  recordId?: string;
  error?: string;
}

// —— 长期表支持的作用域与类别（会话/任务/成果级不进长期表） ——
const LONG_TERM_SCOPES = new Set(['USER', 'DOMAIN', 'PROJECT']);
const LONG_TERM_TYPES: Record<Category, string> = {
  USER_PREFERENCE: 'preference_note',
  DOMAIN_KNOWLEDGE: 'domain_knowledge',
  PROJECT: 'project_fact',
  EXPERIENCE: 'experience',
  SESSION: 'session_note',
  TASK: 'task_note',
  ARTIFACT: 'artifact_note',
  TEMPORARY: 'temporary',
};

/** 业务键 → UserPreference 的 type/category（保持与规则式写入同一口径） */
function preferenceKeyParts(key: string, value: any): { type: string; category: string } {
  const parts = key.split(/[.:]/).filter(Boolean);
  const category = (parts[0] === 'preference' ? parts[1] : parts[0]) || 'general';
  const type = typeof value?.attributes?.sentiment === 'string'
    ? (String(value.attributes.sentiment).toLowerCase() === 'negative' ? 'negative' : 'positive')
    : 'positive';
  return { type, category: category.slice(0, 60) };
}

function dedupeSubstring(content: string): string {
  return content.substring(0, 30);
}

// ==================== 目标记录解析（所有权强制） ====================

async function resolveTarget(userId: string, targetId: string): Promise<
  { table: 'preference'; row: any } | { table: 'requirement'; row: any } | { table: 'longterm'; row: any } | null
> {
  const p = await prisma.userPreference.findFirst({ where: { id: targetId, userId } }).catch(() => null);
  if (p) return { table: 'preference', row: p };
  const r = await prisma.userRequirement.findFirst({ where: { id: targetId, userId } }).catch(() => null);
  if (r) return { table: 'requirement', row: r };
  const m = await prisma.longTermMemory.findFirst({ where: { id: targetId, userId } }).catch(() => null);
  if (m) return { table: 'longterm', row: m };
  return null;
}

async function writeMemoryEvent(tx: any, memoryId: string, eventType: string, detail: string): Promise<void> {
  try {
    await tx.memoryEvent.create({ data: { memoryId, eventType, detail: detail.slice(0, 400) } });
  } catch { /* 审计失败不阻断主操作 */ }
}

// ==================== 各操作执行 ====================

async function addCandidate(userId: string, c: CurationCandidate, conversationId: string, idx: number): Promise<OpOutcome> {
  const base = { index: idx, category: c.category, operation: c.operation, key: c.key };

  // 用户偏好 → UserPreference（复用既有自然键去重 + 强化语义）
  if (c.category === 'USER_PREFERENCE') {
    const { type, category } = preferenceKeyParts(c.key, c.value);
    const existing = await prisma.userPreference.findFirst({
      where: { userId, status: 'active', category, type, content: { contains: dedupeSubstring(c.value.content) } },
    });
    if (existing) {
      await prisma.userPreference.update({
        where: { id: existing.id },
        data: {
          evidenceCount: { increment: 1 },
          confidence: Math.min(0.99, existing.confidence + 0.05),
          lastObservedAt: new Date(),
          ...(c.evidence_type === 'explicit' ? { lastConfirmedAt: new Date(), source: 'explicit' } : {}),
        },
      });
      return { ...base, status: 'reinforced', recordId: existing.id };
    }
    const row = await prisma.userPreference.create({
      data: {
        userId,
        type,
        category,
        content: c.value.content,
        source: c.evidence_type === 'explicit' ? 'explicit' : c.evidence_type,
        strength: c.importance,
        confidence: c.evidence_type === 'explicit' ? Math.max(0.85, c.confidence) : c.confidence,
        status: 'active',
      },
    });
    return { ...base, status: 'saved', recordId: row.id };
  }

  // 其余长期类别只在 USER/DOMAIN/PROJECT 作用域落 LongTermMemory
  if (!LONG_TERM_SCOPES.has(c.scope) || c.category === 'SESSION' || c.category === 'TEMPORARY' || c.category === 'TASK' || c.category === 'ARTIFACT') {
    // ARTIFACT/TASK/SESSION/TEMPORARY 有各自的存储（contextMemory / ActiveTaskState /
    // artifact 表），不进长期记忆，避免伪装保存。
    return { ...base, status: 'skipped_scope' };
  }

  const ltmType = LONG_TERM_TYPES[c.category];
  const existing = await prisma.longTermMemory.findFirst({
    where: {
      userId,
      status: 'active',
      type: ltmType,
      ...(c.value.domain ? { domain: c.value.domain } : {}),
      content: { contains: dedupeSubstring(c.value.content) },
    },
  });
  if (existing) {
    await prisma.longTermMemory.update({
      where: { id: existing.id },
      data: {
        evidenceCount: { increment: 1 },
        confidence: Math.min(0.99, existing.confidence + 0.05),
        lastObservedAt: new Date(),
        ...(c.evidence_type === 'explicit' ? { lastConfirmedAt: new Date() } : {}),
      },
    });
    await prisma.$transaction(async (tx: any) => writeMemoryEvent(tx, existing.id, 'reinforced', `curation add dedupe: ${c.reason || c.key}`));
    return { ...base, status: 'reinforced', recordId: existing.id };
  }

  const row = await prisma.longTermMemory.create({
    data: {
      userId,
      type: ltmType,
      subtype: c.key.slice(0, 80),
      content: c.value.content,
      structuredData: c.value.attributes ? JSON.stringify(c.value.attributes) : null,
      confidence: c.evidence_type === 'explicit' ? Math.max(0.85, c.confidence) : c.confidence,
      importance: c.importance,
      sourceType: `curation:${c.evidence_type}`,
      domain: c.value.domain || (c.scope === 'DOMAIN' ? c.value.domain : null) || null,
      conversationId,
      status: 'active',
    },
  });
  await prisma.$transaction(async (tx: any) => writeMemoryEvent(tx, row.id, 'created', `curation add: ${c.reason || c.key}`));
  return { ...base, status: 'saved', recordId: row.id };
}

async function updateCandidate(userId: string, c: CurationCandidate, merge: boolean, idx: number): Promise<OpOutcome> {
  const base = { index: idx, category: c.category, operation: c.operation, key: c.key };
  if (!c.target_id) return { ...base, status: 'review' };
  const target = await resolveTarget(userId, c.target_id);
  if (!target) return { ...base, status: 'review_target_not_found' };

  if (target.table === 'preference') {
    const updated = await prisma.userPreference.update({
      where: { id: target.row.id },
      data: {
        content: merge ? `${target.row.content}\n${c.value.content}`.slice(0, 2000) : c.value.content,
        confidence: Math.max(target.row.confidence, c.evidence_type === 'explicit' ? 0.9 : c.confidence),
        evidenceCount: { increment: 1 },
        lastObservedAt: new Date(),
        lastConfirmedAt: c.evidence_type === 'explicit' ? new Date() : undefined,
      },
    });
    return { ...base, status: 'saved', recordId: updated.id };
  }
  if (target.table === 'requirement') {
    const updated = await prisma.userRequirement.update({
      where: { id: target.row.id },
      data: {
        content: merge ? `${target.row.content}\n${c.value.content}`.slice(0, 2000) : c.value.content,
      },
    });
    return { ...base, status: 'saved', recordId: updated.id };
  }

  // LongTermMemory：修改走事务（更新 + 审计事件）
  const updatedId = await prisma.$transaction(async (tx: any) => {
    const updatedRow = await tx.longTermMemory.update({
      where: { id: target.row.id },
      data: {
        content: merge ? `${target.row.content}\n${c.value.content}`.slice(0, 2000) : c.value.content,
        confidence: Math.max(target.row.confidence ?? 0, c.evidence_type === 'explicit' ? 0.9 : c.confidence),
        importance: Math.max(target.row.importance ?? 0, c.importance),
        evidenceCount: { increment: 1 },
        lastObservedAt: new Date(),
        lastConfirmedAt: c.evidence_type === 'explicit' ? new Date() : undefined,
      },
    });
    await writeMemoryEvent(tx, updatedRow.id, merge ? 'merged' : 'updated', `curation ${c.operation}: ${c.reason || c.key}`);
    return updatedRow.id;
  });
  return { ...base, status: 'saved', recordId: updatedId };
}

async function archiveOrDeleteCandidate(userId: string, c: CurationCandidate, mode: 'archive' | 'delete', idx: number): Promise<OpOutcome> {
  const base = { index: idx, category: c.category, operation: c.operation, key: c.key };
  if (!c.target_id) return { ...base, status: 'review' };
  const target = await resolveTarget(userId, c.target_id);
  if (!target) return { ...base, status: 'review_target_not_found' };

  if (target.table === 'preference' || target.table === 'requirement') {
    // 归档/删除均采用软删除（status），保留追溯能力；删除仅限用户明确指令
    if (mode === 'delete' && c.evidence_type !== 'explicit') return { ...base, status: 'review' };
    const table = target.table === 'preference' ? prisma.userPreference : prisma.userRequirement;
    await (table as any).update({
      where: { id: target.row.id },
      data: { status: mode === 'delete' ? 'deleted' : 'archived' },
    });
    return { ...base, status: 'saved', recordId: target.row.id };
  }

  const updatedId = await prisma.$transaction(async (tx: any) => {
    await tx.longTermMemory.update({
      where: { id: target.row.id },
      data: mode === 'delete'
        ? { status: 'deleted', deletedAt: new Date() }
        : { status: 'archived' },
    });
    await writeMemoryEvent(tx, target.row.id, mode === 'delete' ? 'deleted' : 'archived', `curation ${c.operation}: ${c.reason || c.key}`);
    return target.row.id;
  });
  return { ...base, status: 'saved', recordId: updatedId };
}

// ==================== 总入口 ====================

/**
 * 执行模型提议的信息整理操作。每个操作独立 try/catch：单条失败不影响其他条目，
 * 结果按操作逐条返回（只有真实写库成功才标记 saved）。
 */
export async function executeCandidateOps(
  userId: string,
  candidates: CurationCandidate[],
  conversationId: string,
): Promise<OpOutcome[]> {
  const outcomes: OpOutcome[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const base = { index: i, category: c.category, operation: c.operation, key: c.key };
    try {
      if (looksLikeSecret(c.value.content)) {
        outcomes.push({ ...base, status: 'rejected_sensitive' });
        continue;
      }
      switch (c.operation) {
        case 'NOOP':
          outcomes.push({ ...base, status: 'noop' });
          break;
        case 'REVIEW':
          outcomes.push({ ...base, status: 'review' });
          break;
        case 'LINK':
          // 当前长期记忆表没有显式关联字段；不伪造能力，标记待人工/后续处理
          outcomes.push({ ...base, status: 'review' });
          break;
        case 'ADD':
          outcomes.push(await addCandidate(userId, c, conversationId, i));
          break;
        case 'UPDATE':
          outcomes.push(await updateCandidate(userId, c, false, i));
          break;
        case 'MERGE':
          outcomes.push(await updateCandidate(userId, c, true, i));
          break;
        case 'ARCHIVE':
          outcomes.push(await archiveOrDeleteCandidate(userId, c, 'archive', i));
          break;
        case 'DELETE':
          outcomes.push(await archiveOrDeleteCandidate(userId, c, 'delete', i));
          break;
        default:
          outcomes.push({ ...base, status: 'review' });
      }
    } catch (err: any) {
      outcomes.push({ ...base, status: 'failed', error: String(err?.message ?? err).slice(0, 200) });
    }
  }
  return outcomes;
}
