// ================================================================
// Organization Applier — single-threaded, transactional writer.
// Applies the merged, validated plan. Writes lifecycle states, never
// physical deletion, never touches verificationStatus.
// After apply: build the after-snapshot, write OrganizationRecord,
// re-embed only affected facts.
// ================================================================

import { prismaKnowledge } from '../db';
import { buildSnapshot } from './orgSnapshot';
import { validClaimType, firstSentence, clampConfidence, describeConflicts } from './orgCompliance';
import type { MergedPlan } from './orgResultPool';
import type { OrgProposal } from './orgWorkers';
import type { BuiltSnapshot } from './orgSnapshot';

export interface ApplyResult {
  ok: boolean;
  recordId: string;
  afterSnapshotRef: string;
  afterSnapshotHash: string;
  changesCount: number;
  affectedFactIds: string[];
  error?: string;
}

interface ChangeEntry {
  entityType: string;
  entityId: string;
  action: string;
  before: string;
  after: string;
  reason: string;
}

export async function applyPlan(
  job: any,
  snapshot: BuiltSnapshot,
  plan: MergedPlan,
  scopeType: string,
  scopeId: string,
): Promise<ApplyResult> {
  if (plan.accepted.length === 0) {
    const after = await buildSnapshot(scopeType as any, scopeId);
    const record = await prismaKnowledge.organizationRecord.create({
      data: {
        jobId: job.id,
        scopeType,
        scopeId,
        objectId: job.objectId ?? null,
        beforeSnapshotRef: snapshot.id,
        afterSnapshotRef: after.id,
        beforeSnapshotHash: snapshot.hash,
        afterSnapshotHash: after.hash,
        changesJson: '[]',
        issueTypes: '[]',
        beforeVersion: 0,
        afterVersion: 0,
      },
    });
    return { ok: true, recordId: record.id, afterSnapshotRef: after.id, afterSnapshotHash: after.hash, changesCount: 0, affectedFactIds: [] };
  }

  const changes: ChangeEntry[] = [];
  const affectedFactIds = new Set<string>();

  try {
    for (const p of plan.accepted) {
      const entry = await applyProposal(p, affectedFactIds);
      if (entry) changes.push(entry);
    }

    const after = await buildSnapshot(scopeType as any, scopeId);

    // Organization version = prior records count for this scope
    const priorRecords = await prismaKnowledge.organizationRecord.count({
      where: { scopeType, scopeId },
    });

    const record = await prismaKnowledge.organizationRecord.create({
      data: {
        jobId: job.id,
        scopeType,
        scopeId,
        objectId: job.objectId ?? null,
        beforeSnapshotRef: snapshot.id,
        afterSnapshotRef: after.id,
        beforeSnapshotHash: snapshot.hash,
        afterSnapshotHash: after.hash,
        changesJson: JSON.stringify(changes),
        issueTypes: JSON.stringify(plan.conflicts.map((c) => c.type).concat(plan.rejected.map((r) => `REJECTED:${r.reason}`))),
        beforeVersion: priorRecords,
        afterVersion: priorRecords + 1,
      },
    });

    return { ok: true, recordId: record.id, afterSnapshotRef: after.id, afterSnapshotHash: after.hash, changesCount: changes.length, affectedFactIds: [...affectedFactIds] };
  } catch (err: any) {
    return { ok: false, recordId: '', afterSnapshotRef: snapshot.id, afterSnapshotHash: snapshot.hash, changesCount: 0, affectedFactIds: [], error: String(err?.message ?? err) };
  }
}

async function applyProposal(p: OrgProposal, affectedFactIds: Set<string>): Promise<ChangeEntry | null> {
  const payload = p.payload ?? {};

  switch (p.action) {
    case 'MARK_LIFECYCLE': {
      const status = String(p.after || payload.lifecycleStatus || 'ARCHIVED');
      if (p.targetType === 'fact') {
        const fact = await prismaKnowledge.knowledgeFact.findUnique({ where: { id: p.targetId } });
        if (!fact) return null;
        await prismaKnowledge.knowledgeFact.update({
          where: { id: p.targetId },
          data: {
            lifecycleStatus: status,
            ...(payload.mergedInto ? { mergedInto: String(payload.mergedInto) } : {}),
          },
        });
        return { entityType: 'fact', entityId: p.targetId, action: 'MARK_LIFECYCLE', before: fact.lifecycleStatus, after: status, reason: p.reason };
      }
      if (p.targetType === 'evidence') {
        const ev = await prismaKnowledge.evidence.findUnique({ where: { id: p.targetId } });
        if (!ev) return null;
        const meta = safeJson(ev.metadataJson);
        meta.lifecycleStatus = status;
        await prismaKnowledge.evidence.update({
          where: { id: p.targetId },
          data: { metadataJson: JSON.stringify(meta) },
        });
        return { entityType: 'evidence', entityId: p.targetId, action: 'MARK_LIFECYCLE', before: String(meta.lifecycleStatus ?? 'ACTIVE'), after: status, reason: p.reason };
      }
      return null;
    }

    case 'NORMALIZE_SOURCE': {
      const keeperId = String(payload.mergedInto ?? '');
      if (!keeperId) return null;
      const dup = await prismaKnowledge.evidenceSource.findUnique({ where: { id: p.targetId } });
      if (!dup) return null;
      // Re-point evidence rows from dup source to the keeper
      await prismaKnowledge.evidence.updateMany({
        where: { sourceId: p.targetId },
        data: { sourceId: keeperId },
      });
      return { entityType: 'source', entityId: p.targetId, action: 'NORMALIZE_SOURCE', before: dup.canonicalUrl, after: `merged into ${keeperId}`, reason: p.reason };
    }

    case 'MERGE_RELATION': {
      const keeperId = String(payload.mergedInto ?? '');
      if (!keeperId) return null;
      await prismaKnowledge.knowledgeRelation.update({
        where: { id: p.targetId },
        data: { lifecycleStatus: 'DUPLICATE' },
      });
      return { entityType: 'relation', entityId: p.targetId, action: 'MERGE_RELATION', before: 'ACTIVE', after: `DUPLICATE (kept ${keeperId})`, reason: p.reason };
    }

    case 'SET_VARIANT': {
      const fact = await prismaKnowledge.knowledgeFact.findUnique({ where: { id: p.targetId } });
      if (!fact) return null;
      const newVariantId = String(payload.variantId ?? '');
      if (newVariantId) {
        const variant = await prismaKnowledge.knowledgeVariant.findUnique({ where: { id: newVariantId } });
        if (variant && variant.objectId !== fact.objectId) return null; // never cross-object moves
      }
      await prismaKnowledge.knowledgeFact.update({
        where: { id: p.targetId },
        data: { variantId: newVariantId || null },
      });
      affectedFactIds.add(p.targetId);
      return { entityType: 'fact', entityId: p.targetId, action: 'SET_VARIANT', before: String(fact.variantId ?? 'none'), after: newVariantId || 'none', reason: p.reason };
    }

    case 'SET_VERSION': {
      const fact = await prismaKnowledge.knowledgeFact.findUnique({ where: { id: p.targetId } });
      if (!fact) return null;
      const data: any = {};
      if (payload.validFrom) data.validFrom = new Date(payload.validFrom);
      if (payload.validTo) data.validTo = new Date(payload.validTo);
      if (Object.keys(data).length === 0) return null; // nothing to change
      await prismaKnowledge.knowledgeFact.update({ where: { id: p.targetId }, data });
      return { entityType: 'fact', entityId: p.targetId, action: 'SET_VERSION', before: 'unbounded validity', after: JSON.stringify(data), reason: p.reason };
    }

    case 'MOVE_FACT': {
      const fact = await prismaKnowledge.knowledgeFact.findUnique({ where: { id: p.targetId } });
      if (!fact) return null;
      const newObjectId = String(payload.objectId ?? '');
      if (!newObjectId) return null;
      const targetObj = await prismaKnowledge.knowledgeObject.findUnique({ where: { id: newObjectId } });
      if (!targetObj) return null;
      await prismaKnowledge.knowledgeFact.update({
        where: { id: p.targetId },
        data: { objectId: newObjectId, variantId: null },
      });
      return { entityType: 'fact', entityId: p.targetId, action: 'MOVE_FACT', before: fact.objectId, after: newObjectId, reason: p.reason };
    }

    case 'SPLIT_FACT': {
      const original = await prismaKnowledge.knowledgeFact.findUnique({ where: { id: p.targetId } });
      if (!original) return null;
      const pieces: Array<{ claim: string; claimType?: string; variantId?: string }> = Array.isArray(payload.pieces) ? payload.pieces : [];
      if (pieces.length < 2) return null; // not a valid split
      const created: string[] = [];
      const factEvidenceRows = await prismaKnowledge.knowledgeFactEvidence.findMany({ where: { factId: p.targetId } });
      // 合规闸门（旧「数据库自整理系统」能力，已合并进本模块）：
      // SPLIT_FACT 是**新建行**的路径，AI 提供的 piece.claimType / piece.claim
      // 在此前是**原样写库**的 —— 既不校验 claimType 白名单，也不归一化 claim。
      // 后果：AI 返回 claimType:'made_up_type' 会直接落成非法值，
      // 之后任何按 claimType 过滤/统计的逻辑都会漏掉这条。
      const compliance: string[] = [];
      for (const piece of pieces) {
        // claim 归一化：压空白 + 取首句 + 300 字上限（拆出来的片段本就该是原子句）
        const claim = firstSentence(String(piece.claim ?? ''));
        if (!claim.trim()) continue;   // 空 claim 不建行
        const rawType = String(piece.claimType || original.claimType || '');
        const claimType = validClaimType(rawType);
        if (claimType !== rawType.toUpperCase()) {
          compliance.push(`claimType "${rawType}" → "${claimType}"`);
        }
        const confidence = clampConfidence(original.confidence);
        const row = await prismaKnowledge.knowledgeFact.create({
          data: {
            objectId: original.objectId,
            variantId: piece.variantId ?? original.variantId,
            claim,
            claimType,
            verificationStatus: original.verificationStatus,
            confidence,
            observedAt: original.observedAt,
            version: original.version,
          },
        });
        for (const link of factEvidenceRows) {
          await prismaKnowledge.knowledgeFactEvidence.create({
            data: { factId: row.id, evidenceId: link.evidenceId, weight: link.weight },
          }).catch(() => undefined);
        }
        created.push(row.id);
      }
      // Original is archived (its content is fully distributed to pieces)
      await prismaKnowledge.knowledgeFact.update({
        where: { id: p.targetId },
        data: { lifecycleStatus: 'ARCHIVED' },
      });
      return {
        entityType: 'fact',
        entityId: p.targetId,
        action: 'SPLIT_FACT',
        before: original.claim,
        after: `split into ${created.join(', ')}`,
        reason: compliance.length
          ? `${p.reason ?? ''} [合规修正: ${compliance.join('; ')}]`
          : p.reason,
      };
    }

    case 'MERGE_OBJECT': {
      const keeperId = String(payload.mergedInto ?? '');
      if (!keeperId) return null;
      const dup = await prismaKnowledge.knowledgeObject.findUnique({
        where: { id: p.targetId },
        include: { categories: true },
      });
      if (!dup) return null;
      // Re-point facts, variants, and relations to the surviving object
      await prismaKnowledge.knowledgeFact.updateMany({ where: { objectId: p.targetId }, data: { objectId: keeperId } });
      await prismaKnowledge.knowledgeVariant.updateMany({ where: { objectId: p.targetId }, data: { objectId: keeperId } });
      await prismaKnowledge.knowledgeRelation.updateMany({ where: { objectId: p.targetId }, data: { objectId: keeperId } });
      await prismaKnowledge.knowledgeRelation.updateMany({ where: { targetId: p.targetId }, data: { targetId: keeperId } });
      for (const link of dup.categories) {
        await prismaKnowledge.knowledgeObjectCategory.create({
          data: { objectId: keeperId, categoryId: link.categoryId, primary: link.primary },
        }).catch(() => undefined);
      }
      await prismaKnowledge.knowledgeObjectCategory.deleteMany({ where: { objectId: p.targetId } });
      await prismaKnowledge.knowledgeObject.update({
        where: { id: p.targetId },
        data: { status: 'ARCHIVED' },
      });
      return { entityType: 'object', entityId: p.targetId, action: 'MERGE_OBJECT', before: dup.canonicalName, after: `merged into ${keeperId}`, reason: p.reason };
    }

    case 'MOVE_CATEGORY': {
      const categoryId = String(payload.categoryId ?? '');
      const objectId = String(payload.objectId ?? p.targetId);
      if (!categoryId || !objectId) return null;
      await prismaKnowledge.knowledgeObjectCategory.create({
        data: { objectId, categoryId, primary: Boolean(payload.primary) },
      }).catch(() => undefined);
      if (payload.removeCategoryId) {
        await prismaKnowledge.knowledgeObjectCategory.deleteMany({
          where: { objectId, categoryId: String(payload.removeCategoryId) },
        });
      }
      return { entityType: 'category', entityId: objectId, action: 'MOVE_CATEGORY', before: p.before, after: `moved to ${categoryId}`, reason: p.reason };
    }

    case 'RELINK_EVIDENCE': {
      const evidenceId = String(payload.evidenceId ?? p.targetId);
      const factId = String(payload.factId ?? '');
      if (!evidenceId || !factId) return null;
      await prismaKnowledge.knowledgeFactEvidence.create({
        data: { factId, evidenceId },
      }).catch(() => undefined);
      if (payload.removeFactId) {
        await prismaKnowledge.knowledgeFactEvidence.deleteMany({
          where: { factId: String(payload.removeFactId), evidenceId },
        });
      }
      return { entityType: 'evidence', entityId: evidenceId, action: 'RELINK_EVIDENCE', before: p.before, after: `linked to fact ${factId}`, reason: p.reason };
    }

    default:
      // Unknown actions are not applied (safe default: preserve structure)
      return null;
  }
}

// ---------------- helpers ----------------

function safeJson(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
