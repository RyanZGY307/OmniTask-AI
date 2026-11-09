// ================================================================
// 审计：复用已有 EvolutionAudit 表（knowledge 库），不建重复表。
// ================================================================

import { prismaKnowledge } from '../db';

export type AuditAction =
  | 'asset_registered' | 'version_created' | 'change_created' | 'change_transitioned'
  | 'approved' | 'rejected' | 'experiment_run' | 'canary_started' | 'canary_promoted'
  | 'canary_rolled_back' | 'released' | 'paused' | 'resumed' | 'signal_bridged'
  | 'permission_denied' | 'guard_blocked'
  | 'auto_approved' | 'signal_buffered' | 'signal_flushed'
  | 'rsi_provider_config_saved' | 'rsi_provider_config_disabled';

export async function writeAudit(input: {
  action: AuditAction;
  candidateId?: string | null;
  adminId?: string | null;
  scope?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await prismaKnowledge.evolutionAudit.create({
      data: {
        action: input.action,
        candidateId: input.candidateId ?? null,
        adminId: input.adminId ?? null,
        scope: input.scope ?? null,
        reason: input.reason ? String(input.reason).slice(0, 300) : null,
        metadata: input.metadata ? JSON.stringify(input.metadata).slice(0, 2000) : null,
      },
    });
  } catch (err) {
    // 审计写失败只记日志，不阻断主流程（尽力而为），保证可观测
    console.error('[RSI][audit] write failed', String((err as Error)?.message ?? err));
  }
}
