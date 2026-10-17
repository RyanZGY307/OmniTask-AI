// ================================================================
// Permission Engine
// User Permission + Connection Permission + Tool Risk → Allow / Deny / Confirm
//
// Policy values per risk level (R0..R4), user-configurable:
//   auto     → execute immediately
//   confirm  → create pending ActionRequest, requires explicit approval
//   always   → same as confirm (alias kept for UI)
//   never    → deny outright
//
// Rationale: R0 read-only and R1 low-impact writes default to auto;
// R2 (external communication) and R3 default to confirm; R4 (sensitive/financial)
// defaults to confirm but is capped: even "auto" cannot be set for R4 by users,
// the server enforces confirm.
// ================================================================

import { prisma } from '../services/db';
import { ActionPolicy, PolicyValue, RiskLevel } from './types';

export const DEFAULT_POLICY: ActionPolicy = {
  R0: 'auto',
  R1: 'auto',
  R2: 'confirm',
  R3: 'confirm',
  R4: 'never',
};

const VALID_VALUES: PolicyValue[] = ['auto', 'confirm', 'always', 'never'];

export function normalizePolicy(input: unknown): ActionPolicy {
  const out = { ...DEFAULT_POLICY };
  if (input && typeof input === 'object') {
    for (const level of Object.keys(out) as RiskLevel[]) {
      const v = (input as Record<string, unknown>)[level];
      if (typeof v === 'string' && VALID_VALUES.includes(v as PolicyValue)) out[level] = v as PolicyValue;
    }
  }
  // R4 can never be auto
  if (out.R4 === 'auto') out.R4 = 'confirm';
  return out;
}

export async function getPolicy(userId: string): Promise<ActionPolicy> {
  const setting = await prisma.userSetting.findUnique({ where: { userId } });
  return normalizePolicy(setting?.actionPolicies ? JSON.parse(setting.actionPolicies) : undefined);
}

export async function setPolicy(userId: string, policy: unknown): Promise<ActionPolicy> {
  const normalized = normalizePolicy(policy);
  await prisma.userSetting.upsert({
    where: { userId },
    update: { actionPolicies: JSON.stringify(normalized) },
    create: { userId, actionPolicies: JSON.stringify(normalized) },
  });
  return normalized;
}

export type Decision = 'allow' | 'deny' | 'confirm';

export interface PermissionCheck {
  decision: Decision;
  reason?: string;
  policy: PolicyValue;
  effectivePolicy: PolicyValue;
}

export async function checkPermission(params: {
  userId: string;
  riskLevel: RiskLevel;
  requiredCapability?: string;
  connection?: { status: string; permissions: string[] } | null;
}): Promise<PermissionCheck> {
  const { userId, riskLevel, requiredCapability, connection } = params;
  const policy = await getPolicy(userId);
  const userValue = policy[riskLevel];

  // Connection-level gate: the capability must be granted on the active connection
  if (requiredCapability && connection) {
    if (connection.status !== 'active') {
      return { decision: 'deny', reason: `Connection is ${connection.status}`, policy: userValue, effectivePolicy: userValue };
    }
    if (!connection.permissions.includes(requiredCapability)) {
      return { decision: 'deny', reason: `Connection lacks capability ${requiredCapability}`, policy: userValue, effectivePolicy: userValue };
    }
  }

  // Effective policy: 'always' behaves like 'confirm'
  const effective: PolicyValue = userValue === 'always' ? 'confirm' : userValue;
  if (effective === 'never') {
    return { decision: 'deny', reason: `Policy "${effective}" for ${riskLevel}`, policy: userValue, effectivePolicy: effective };
  }
  if (effective === 'confirm') {
    return { decision: 'confirm', policy: userValue, effectivePolicy: effective };
  }
  return { decision: 'allow', policy: userValue, effectivePolicy: effective };
}
