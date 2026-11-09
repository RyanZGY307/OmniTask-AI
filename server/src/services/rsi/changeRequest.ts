// ================================================================
// ChangeRequest 状态机 + 写库。状态迁移由 types.CHANGE_TRANSITIONS 约束。
// ================================================================

import { prismaKnowledge } from '../db';
import { canTransition } from './changeState';
import { type ChangeStatus, type RiskLevel } from './types';

export interface CreateChangeInput {
  assetId: string;
  assetKey: string;
  fromVersion: number;
  toVersion: number;
  proposal: string;
  hypothesis: string;
  evidenceRefs?: string[];
  riskLevel: RiskLevel;
  gateLevel?: number;
  proposedBy: string;
  proposerKind: string;
  baselineId?: string;
}

export async function createChangeRequest(input: CreateChangeInput) {
  if (input.fromVersion < 0 || input.toVersion <= 0) throw new Error('bad_version');
  if (input.toVersion <= input.fromVersion && input.fromVersion > 0) throw new Error('version_not_increasing');
  return prismaKnowledge.changeRequest.create({
    data: {
      assetId: input.assetId,
      assetKey: input.assetKey,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      proposal: input.proposal,
      hypothesis: input.hypothesis.slice(0, 800),
      evidenceRefs: JSON.stringify(input.evidenceRefs ?? []),
      riskLevel: input.riskLevel,
      gateLevel: input.gateLevel ?? riskDefaultGate(input.riskLevel),
      proposedBy: input.proposedBy,
      proposerKind: input.proposerKind,
      baselineId: input.baselineId ?? null,
      status: 'pending',
    },
  });
}

export function riskDefaultGate(risk: RiskLevel): number {
  if (risk === 'r3') return 3;
  if (risk === 'r2') return 2;
  return 1;
}

/** 状态迁移：非法迁移抛错（fail-closed）。 */
export async function transition(changeId: string, to: ChangeStatus, extra?: {
  decidedBy?: string; rejectReason?: string; evaluationJson?: string; canaryPercent?: number; rolloutId?: string;
}): Promise<void> {
  const cur = await prismaKnowledge.changeRequest.findUnique({ where: { id: changeId } });
  if (!cur) throw new Error('change_not_found');
  if (cur.status === to) return; // 幂等
  if (!canTransition(cur.status, to)) {
    throw new Error(`illegal_transition:${cur.status}->${to}`);
  }
  const data: Record<string, unknown> = { status: to };
  if (to === 'approved' || to === 'rejected' || to === 'awaiting_approval') {
    data.decidedBy = extra?.decidedBy ?? cur.decidedBy;
    data.decidedAt = new Date();
  }
  if (to === 'rejected') data.rejectReason = extra?.rejectReason ?? cur.rejectReason;
  if (extra?.evaluationJson !== undefined) data.evaluationJson = extra.evaluationJson;
  if (extra?.canaryPercent !== undefined) data.canaryPercent = extra.canaryPercent;
  if (extra?.rolloutId !== undefined) data.rolloutId = extra.rolloutId;
  await prismaKnowledge.changeRequest.update({ where: { id: changeId }, data });
}

export async function getChange(changeId: string) {
  return prismaKnowledge.changeRequest.findUnique({ where: { id: changeId } });
}

export async function listChanges(filter: { status?: string; riskLevel?: string; limit?: number } = {}) {
  return prismaKnowledge.changeRequest.findMany({
    where: {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.riskLevel ? { riskLevel: filter.riskLevel } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(filter.limit ?? 30, 50),
  });
}

export async function countOpenForAsset(assetKey: string): Promise<number> {
  return prismaKnowledge.changeRequest.count({
    where: { assetKey, status: { in: ['pending', 'awaiting_approval', 'evaluating', 'approved', 'canary'] } },
  });
}

/**
 * 审批：禁止发起者自审。
 * 判定按「主体相同」而非字符串相等：proposerKind === approverKind 时一律拒绝
 * （worker 不能给自己放行，必须换成 admin/user 主体）。
 */
export async function approveChange(
  changeId: string,
  decidedBy: string,
  allowSelf: boolean,
  approverKind?: string,
): Promise<void> {
  const cur = await getChange(changeId);
  if (!cur) throw new Error('change_not_found');
  if (!allowSelf) {
    if (approverKind && cur.proposerKind && approverKind === cur.proposerKind) {
      throw new Error('self_approval_denied');
    }
    if (cur.proposedBy === decidedBy) throw new Error('self_approval_denied');
    if (approverKind === 'worker' || approverKind === 'service' || approverKind === 'plugin') {
      throw new Error('self_approval_denied');
    }
  }
  await transition(changeId, 'approved', { decidedBy });
}

export async function rejectChange(changeId: string, decidedBy: string, reason: string): Promise<void> {
  await transition(changeId, 'rejected', { decidedBy, rejectReason: reason.slice(0, 300) });
}
