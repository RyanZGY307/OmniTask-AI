// ================================================================
// RSI 主链路编排：Observability → Signal → Candidate → Evidence → AI Proposal
//   → Validator → Experiment → Compare → Approval → Version → Canary → Monitor
//   → Promote/Rollback → Audit → Experience
//
// 第六阶段修正（相对第五阶段）：
// 1. baseline 改为真实采集（metrics.collectChatMetrics），不再传空 metrics；
// 2. 自动批准后进入 canary（不直接 released），灰度走 scheduledRolloutCheck；
// 3. 回滚恢复到「上一个 released 版本」内容，而不是当前版本；
// 4. 判定接入 Wilson 下界与真 P95；指标缺失一律 hold；
// 5. 失败即短路并写审计，绝不伪造成功。
// ================================================================

import { prismaKnowledge } from '../db';
import { can, type Actor, type AssetRef, type RiskLevel, type ChangeStatus } from './authorization';
import {
  registerAsset, createVersion, getCurrentVersion, releaseVersion, hash16, getAsset,
  getPreviousReleasedVersion, resolveReleasedContent,
} from './assetRegistry';
import { createChangeRequest, transition, getChange, approveChange, rejectChange, canTransition, countOpenForAsset } from './changeRequest';
import { evaluateNoise } from './noiseGate';
import { assembleEvidence, summarizeForLongTerm, enoughSamples } from './evidenceAssembler';
import { bridgeSignals, dedupeKey, type BridgeSource, type RsiSignal } from './signalBridge';
import { proposeCandidate, assistEvaluation, parseJsonLoose } from './aiProposal';
import { validateCandidate } from './candidateValidator';
import { runIsolatedExperiment, compareRegionAB } from './experimentRunner';
import { computeGroup, collectChatMetrics, collectGroup, collectRawSamples, splitByBucket, type GroupStats, type RawSample } from './metrics';
import { computeMetrics, compare } from './baselineComparator';
import { decideOutcome, inRollout, toDecider } from './rollout';
import { checkPause, resume as resumeRow, expireOverduePauses, isWorkerPaused } from './systemPause';
import { writeAudit } from './audit';
import { recordExperience, listExperience, recentFailureCount } from './experienceLibrary';
import { todayCount } from './budget';
import { isExpired } from '../observability/pgStats';

export interface StageLog { stage: string; ok: boolean; detail?: string; at: string }

export interface RunOutcome {
  changeId?: string;
  status: ChangeStatus | 'skipped';
  stages: StageLog[];
  denied?: string;
}

function log(stages: StageLog[], stage: string, ok: boolean, detail?: string) {
  stages.push({ stage, ok, detail, at: new Date().toISOString() });
}

/** 信号资产类型 → 窗口；无可用窗口返回 null（调用方 fail-closed）。 */
async function collectBaselineFor(kind: string): Promise<{ stats: GroupStats | null; note: string }> {
  const stats = await collectChatMetrics(24);
  if (!stats) return { stats: null, note: 'db_unavailable' };
  if (stats.samples === 0) return { stats, note: 'no_samples' };
  return { stats, note: `${kind}:${stats.samples}` };
}

/** 单信号 → 单候选 → 隔离实验 → 变更申请 → canary（或 awaiting_approval）。 */
export async function runSignalToCandidate(input: {
  signal: RsiSignal;
  currentContent: string;
  assetType?: string;
  allowedAssetKeys?: string[];
  autoApprove?: boolean;
  approverId?: string;
  workerKind?: string;
}): Promise<RunOutcome> {
  const stages: StageLog[] = [];
  const assetType = input.assetType ?? input.signal.assetType;
  const assetKey = input.signal.assetKey;
  const actor: Actor = { kind: 'worker', id: 'rsi-worker' };

  // ---- 0) 暂停检查（fail-closed）----
  try {
    const paused = await checkPause({ scope: 'asset_key', resource: assetKey, level: 'write' });
    if (paused.paused) {
      log(stages, 'pause_check', false, paused.reason);
      await writeAudit({ action: 'guard_blocked', reason: `paused:${paused.reason}`, scope: assetKey });
      return { status: 'skipped', stages, denied: 'paused' };
    }
    log(stages, 'pause_check', true);
  } catch (e) {
    log(stages, 'pause_check', false, String((e as Error).message));
    await writeAudit({ action: 'guard_blocked', reason: 'pause_state_unknown', scope: assetKey });
    return { status: 'skipped', stages, denied: 'pause_state_unknown' };
  }

  // ---- 1) 权限（状态/归属从 DB 读，不再硬编码 active/global）----
  const existing = await getAsset(assetType, assetKey).catch(() => null);
  const assetStatus = existing?.status ?? 'active';
  const ref: AssetRef = {
    assetType, assetKey,
    scope: (existing?.scope as AssetRef['scope']) ?? 'global',
    ownerId: existing?.ownerId ?? undefined,
  };
  const perm = can(actor, 'propose', ref, input.signal.riskLevel, assetStatus);
  if (!perm.allow) {
    log(stages, 'permission', false, perm.detail ?? perm.reason);
    await writeAudit({ action: 'permission_denied', reason: perm.reason, scope: assetKey, metadata: { assetStatus, scope: ref.scope, ownerId: ref.ownerId ?? null } });
    return { status: 'skipped', stages, denied: perm.reason };
  }
  log(stages, 'permission', true, `status=${assetStatus} scope=${ref.scope}`);

  // ---- 2) 噪声门 ----
  const recent = await recentFailureCount(assetKey);
  const openCount = await countOpenForAsset(assetKey);
  const today = await todayCount();
  const noise = evaluateNoise({
    severity: input.signal.severity,
    recentSameType: recent,
    lastProposalAt: null,
    openChangeCount: openCount,
    todayCount: today,
  });
  if (!noise.pass) {
    log(stages, 'noise_gate', false, noise.failed.join(','));
    await writeAudit({ action: 'guard_blocked', reason: `noise:${noise.failed.join(',')}`, scope: assetKey });
    return { status: 'skipped', stages, denied: noise.failed.join(',') };
  }
  log(stages, 'noise_gate', true);

  // ---- 3) 证据装配（真实基线；缺信号/缺基线/样本不足即拒）----
  const { stats: baseStats, note: baseNote } = await collectBaselineFor(input.signal.kind);
  if (!baseStats || baseStats.samples === 0) {
    log(stages, 'evidence', false, `baseline_${baseNote}`);
    await writeAudit({ action: 'guard_blocked', reason: `evidence:baseline_${baseNote}`, scope: assetKey });
    return { status: 'skipped', stages, denied: `baseline_${baseNote}` };
  }
  if (!enoughSamples({ sampleCount: baseStats.samples, windowHours: 24, metrics: {}, sourceIds: baseStats.sourceIds })) {
    log(stages, 'evidence', false, 'baseline_samples_insufficient');
    await writeAudit({ action: 'guard_blocked', reason: 'evidence:baseline_samples_insufficient', scope: assetKey });
    return { status: 'skipped', stages, denied: 'baseline_samples_insufficient' };
  }
  const hist = await listExperience(assetKey, 5);
  const evidence = assembleEvidence({
    signals: [{
      signalId: input.signal.sourceId,
      signalType: input.signal.kind,
      severity: input.signal.severity,
      createdAt: input.signal.observedAt,
      detail: input.signal.message,
    }],
    context: { text: input.signal.message },
    baseline: {
      windowHours: 24,
      samples: baseStats.samples,
      metrics: {
        successRate: baseStats.successes / Math.max(1, baseStats.samples),
        errorRate: baseStats.errorEvents / Math.max(1, baseStats.samples),
        p95LatencyMs: computeGroup(baseStats).p95LatencyMs ?? -1,
        avgLatencyMs: computeGroup(baseStats).avgLatencyMs ?? -1,
        totalTokens: baseStats.totalTokens,
        totalApiCostUsd: baseStats.totalApiCostUsd,
      },
      sourceIds: baseStats.sourceIds,
    },
    history: [],
    currentVersion: null,
    relatedChanges: openCount,
  });
  if (!evidence.complete || !evidence.bundle) {
    log(stages, 'evidence', false, evidence.missing.join(','));
    await writeAudit({ action: 'guard_blocked', reason: `evidence:${evidence.missing.join(',')}`, scope: assetKey });
    return { status: 'skipped', stages, denied: evidence.missing.join(',') };
  }
  log(stages, 'evidence', true, `signals=1 samples=${baseStats.samples}`);

  // ---- 4) 资产登记 + 当前生产内容 ----
  const asset = await registerAsset({
    assetType, assetKey, actorKind: 'worker', actorId: 'rsi-worker',
  });
  const cur = await getAsset(assetType, assetKey);
  if (cur && (cur.status === 'paused' || cur.status === 'quarantined')) {
    log(stages, 'asset_register', false, `status=${cur.status}`);
    await writeAudit({ action: 'guard_blocked', reason: `asset_state:${cur.status}`, scope: assetKey });
    return { status: 'skipped', stages, denied: 'asset_state' };
  }
  const released = await resolveReleasedContent(assetKey);
  const currentContent = input.currentContent || released?.content || '';
  if (!currentContent || currentContent.trim().length === 0) {
    // 没有当前生产内容 = 没有基线可比，直接短路，不与 diff 规则混在一起
    log(stages, 'asset_register', false, 'missing_current_content');
    await writeAudit({ action: 'guard_blocked', reason: 'missing_current_content', scope: assetKey });
    return { status: 'skipped', stages, denied: 'missing_current_content' };
  }
  await writeAudit({ action: 'asset_registered', scope: assetKey });
  const versionRow = await createVersion({
    assetType, assetKey, content: currentContent, actorKind: 'worker', actorId: 'rsi-worker',
  });
  log(stages, 'version_created', true, `v${versionRow.version}`);
  await writeAudit({ action: 'version_created', scope: assetKey, metadata: { version: versionRow.version } });

  // ---- 5) AI 提议 ----
  const proposal = await proposeCandidate({
    assetType, assetKey,
    currentContent,
    evidenceSummary: summarizeForLongTerm(evidence.bundle),
    signalKinds: [input.signal.kind],
  }, input.signal.riskLevel);
  if (!proposal.ok || !proposal.proposal) {
    log(stages, 'ai_proposal', false, proposal.reason ?? 'unknown');
    await writeAudit({ action: 'guard_blocked', reason: `ai_proposal:${proposal.reason}`, scope: assetKey });
    return { status: 'skipped', stages, denied: `ai_proposal:${proposal.reason}` };
  }
  log(stages, 'ai_proposal', true, `model=${proposal.modelUsed ?? 'default'}`);

  // ---- 6) 候选校验（纯代码）----
  const validation = validateCandidate({
    proposal: proposal.proposal,
    currentInstruction: currentContent,
    allowedAssetKeys: input.allowedAssetKeys,
  });
  if (!validation.ok) {
    log(stages, 'candidate_validate', false, validation.violations.join(','));
    await writeAudit({ action: 'guard_blocked', reason: `validate:${validation.violations.join(',')}`, scope: assetKey });
    return { status: 'skipped', stages, denied: validation.violations.join(',') };
  }
  log(stages, 'candidate_validate', true, `diff=${validation.diffRatio.toFixed(3)}`);

  // ---- 6.5) 独立评估（辅助证据；明确 unsafe 才拦截，评估失败降级为不拦截）----
  const evalResult = await assistEvaluation({
    proposal: proposal.proposal,
    evidenceSummary: summarizeForLongTerm(evidence.bundle),
    riskLevel: input.signal.riskLevel,
  });
  if (evalResult && evalResult.safe === false) {
    log(stages, 'assist_evaluation', false, evalResult.reason);
    await writeAudit({ action: 'guard_blocked', reason: `assist_eval_unsafe:${evalResult.reason}`, scope: assetKey });
    return { status: 'skipped', stages, denied: 'assist_eval_unsafe' };
  }
  log(stages, 'assist_evaluation', true, evalResult ? `quality=${evalResult.quality} pass=${evalResult.pass}` : 'evaluator_unavailable');

  // ---- 7) 隔离实验（确定性优先；知识类走 region A/B；运行时结果由真实采集灌注）----
  // 隔离实验：确定性优先；有足够真实样本时，按与灰度一致的稳定分桶构造「对照/候选」两组。
  // 任一组样本不足 30 就不做运行时对照（stage=deterministic），绝不拿同一组自比造绿。
  let runtime: { controlGroup: GroupStats; variantGroup: GroupStats; minSamples: number } | undefined;
  try {
    const pct = clampInt(process.env.RSI_CANARY_PERCENT || '5', 5, 0, 100);
    const raw = await collectRawSamples(24);
    if (raw.length >= 60) {
      const { variant, control } = splitByBucket(raw, assetKey, pct);
      if (variant.length >= 30 && control.length >= 30) {
        runtime = { controlGroup: collectGroup(control), variantGroup: collectGroup(variant), minSamples: 30 };
      }
    }
  } catch { /* DB 不可用：只跑确定性检查 */ }
  const exp = runIsolatedExperiment({
    deterministic: { proposal: proposal.proposal, currentInstruction: currentContent, allowedAssetKeys: input.allowedAssetKeys },
    runtime,
  });
  if (!exp.passed) {
    log(stages, 'isolated_experiment', false, exp.violations.join(','));
    await writeAudit({ action: 'guard_blocked', reason: `experiment:${exp.violations.join(',')}`, scope: assetKey });
    return { status: 'skipped', stages, denied: 'experiment_failed' };
  }
  log(stages, 'isolated_experiment', true, `stage=${exp.stage}`);

  // ---- 8) 变更申请 ----
  const change = await createChangeRequest({
    assetId: asset.id,
    assetKey,
    fromVersion: versionRow.version,
    toVersion: versionRow.version + 1,
    proposal: JSON.stringify(proposal.proposal),
    hypothesis: proposal.proposal.hypothesis,
    evidenceRefs: [input.signal.sourceId, ...baseStats.sourceIds.slice(0, 5)],
    riskLevel: input.signal.riskLevel,
    proposedBy: 'rsi-worker',
    proposerKind: 'worker',
    baselineId: input.signal.sourceId,
  });
  log(stages, 'change_created', true, change.id);
  await writeAudit({ action: 'change_created', candidateId: change.id, scope: assetKey });

  // ---- 9) 状态：默认一律 awaiting_approval；仅当显式开启 RSI_AUTO_APPROVE 且风险等级在白名单内才自动批准 ----
  const autoApproveEnabled = String(process.env.RSI_AUTO_APPROVE ?? '').toLowerCase() === '1' || String(process.env.RSI_AUTO_APPROVE ?? '').toLowerCase() === 'true';
  const autoApproveLevels = new Set(['r0']);
  if (!autoApproveEnabled || !autoApproveLevels.has(input.signal.riskLevel)) {
    await transition(change.id, 'awaiting_approval');
    log(stages, 'awaiting_approval', true);
    await writeAudit({ action: 'change_transitioned', candidateId: change.id, scope: assetKey, reason: 'awaiting_human_approval' });
    return { changeId: change.id, status: 'awaiting_approval', stages };
  }
  const autoApproverId = input.approverId ?? 'rsi-worker-auto';
  await approveChange(change.id, autoApproverId, false, 'worker');
  log(stages, 'approved', true, autoApproverId);
  await writeAudit({ action: 'auto_approved', candidateId: change.id, scope: assetKey, adminId: autoApproverId, metadata: { proposerKind: 'worker', riskLevel: input.signal.riskLevel } });

  // ---- 10) 灰度：内容已由候选提供，直接进 canary，由 scheduledRolloutCheck 判定 ----
  const newVersion = await createVersion({
    assetType, assetKey, content: proposal.proposal.content, actorKind: 'worker', actorId: 'rsi-worker',
  });
  const canaryPercent = parseInt(process.env.RSI_DEFAULT_CANARY_PERCENT || '5', 10) || 5;
  await transition(change.id, 'canary', { canaryPercent, rolloutId: `rollout:${newVersion.version}` });
  log(stages, 'canary', true, `v${newVersion.version} @${canaryPercent}%`);
  await writeAudit({
    action: 'change_transitioned', candidateId: change.id, scope: assetKey,
    metadata: { canaryVersion: newVersion.version, canaryPercent },
    reason: 'canary_started',
  });

  return { changeId: change.id, status: 'canary', stages };
}

/** 灰度监控：达到门槛 promote，不达标 rollback（回滚=恢复上一个 released 内容为新版本）。 */
export async function monitorRollout(changeId: string, metrics: {
  baseline: GroupStats; candidate: GroupStats; minSamples?: number; canaryStartedAt?: Date | string | null;
}): Promise<{ outcome: 'promote' | 'hold' | 'rollback'; reasons: string[] }> {
  const change = await getChange(changeId);
  if (!change) throw new Error('change_not_found');
  if (change.status !== 'canary') return { outcome: 'hold', reasons: [`状态 ${change.status} 不在 canary`] };
  const b = computeGroup(metrics.baseline);
  const c = computeGroup(metrics.candidate);
  const decision = decideOutcome({
    baseline: toDecider(b), candidate: toDecider(c),
    riskLevel: change.riskLevel as RiskLevel,
    canaryStartedAt: metrics.canaryStartedAt ?? (change as unknown as { updatedAt?: Date }).updatedAt ?? null,
  });
  const reasons = decision.reasons;
  if (decision.outcome === 'rollback') {
    // 回滚 = 把「上一个 released 版本」的内容重新发布为新版本，历史不可覆盖
    const prev = await getPreviousReleasedVersion(change.assetKey);
    const restoreContent = prev ? (prev.content ?? prev.contentRef) : '';
    const rv = await createVersion({
      assetType: 'knowledge_fact', assetKey: change.assetKey,
      content: restoreContent, actorKind: 'worker', actorId: 'rsi-monitor',
    });
    await releaseVersion(change.assetKey, rv.version);
    await transition(changeId, 'rolled_back');
    await recordExperience({ candidateId: changeId, assetKey: change.assetKey, outcome: 'rolled_back', metrics: { ...c.metrics, note: 'rolled_back' } });
    await writeAudit({ action: 'canary_rolled_back', candidateId: changeId, scope: change.assetKey, metadata: { version: rv.version, restoredFrom: prev?.version ?? null, reasons } });
    return { outcome: 'rollback', reasons };
  }
  if (decision.outcome === 'promote') {
    await releaseVersion(change.assetKey, change.toVersion);
    await transition(changeId, 'released');
    await recordExperience({ candidateId: changeId, assetKey: change.assetKey, outcome: 'released', metrics: { ...c.metrics } });
    await writeAudit({ action: 'canary_promoted', candidateId: changeId, scope: change.assetKey, metadata: { version: change.toVersion } });
    return { outcome: 'promote', reasons };
  }
  return { outcome: 'hold', reasons };
}

/** 灰度分流判定（供运行时按用户取版本）。 */
export function rolloutEntry(actorId: string, assetKey: string, percent: number) {
  return inRollout(actorId, assetKey, percent);
}

export { compareRegionAB };
export type { GroupStats, RawSample };
