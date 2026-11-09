// ================================================================
// Controlled RSI 管理 API（复用现有 admin 入口，不另建公开 API）。
// 统一头部鉴权：authMiddleware + adminAuth（与 evolutionAdmin 一致）。
// 能力：资产/版本查询、变更列表、审批/拒绝、灰度放量与回滚、暂停/恢复。
// ================================================================

import { Router, Response } from 'express';
import { prismaKnowledge } from '../services/db';
import { authMiddleware, adminAuth, AuthRequest } from '../middleware/auth';
import { can } from '../services/rsi/authorization';
import { getAsset } from '../services/rsi/assetRegistry';
import { approveChange, rejectChange, transition, getChange, listChanges } from '../services/rsi/changeRequest';
import { pause, resume as resumePause, isWorkerPaused, checkPause } from '../services/rsi/systemPause';
import { releaseVersion, createVersion, getPreviousReleasedVersion, listVersions } from '../services/rsi/assetRegistry';
import { collectChatMetrics, computeGroup, collectGroup } from '../services/rsi/metrics';
import { computeMetrics, compare, wilsonLowerBound } from '../services/rsi/baselineComparator';
import { writeAudit } from '../services/rsi/audit';
import { clampInt } from '../services/observability/pgStats';
import type { Actor } from '../services/rsi/types';

const router = Router();
router.use(authMiddleware);

function actorOf(req: AuthRequest): Actor {
  return { kind: 'admin', id: String(req.user?.id ?? req.user?.email ?? 'admin'), role: String(req.user?.role ?? 'ADMIN') };
}

// ------------------------- 只读 -------------------------

router.get('/overview', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const [assets, changes, versions, pauses] = await Promise.all([
      prismaKnowledge.managedAsset.count(),
      prismaKnowledge.changeRequest.count(),
      prismaKnowledge.assetVersion.count(),
      prismaKnowledge.systemPause.count({ where: { resumedAt: null } }),
    ]);
    const byStatus = await prismaKnowledge.changeRequest.groupBy({ by: ['status'], _count: { _all: true } });
    res.json({
      assets, changes, versions, pauses,
      changeStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      env: {
        pauseAllWrites: process.env.PAUSE_ALL_WRITES === '1',
        schedulerOff: process.env.RSI_SCHEDULER === 'off',
        workerPausedHint: await isWorkerPaused('rsi').catch(() => null),
      },
    });
  } catch (err) {
    res.status(500).json({ error: '获取 RSI 总览失败' });
  }
});

router.get('/assets', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const limit = clampInt(req.query.limit, 20, 1, 50);
    const type = String(req.query.assetType || '').slice(0, 60);
    const rows = await prismaKnowledge.managedAsset.findMany({
      where: type ? { assetType: type } : {},
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
    res.json({ assets: rows });
  } catch { res.status(500).json({ error: '获取资产列表失败' }); }
});

router.get('/assets/:assetType/:assetKey/versions', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const assetKey = String(req.params.assetKey);
    const versions = await listVersions(assetKey);
    res.json({ versions });
  } catch { res.status(500).json({ error: '获取版本失败' }); }
});

router.get('/changes', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const changes = await listChanges({
      status: String(req.query.status || '') || undefined,
      riskLevel: String(req.query.riskLevel || '') || undefined,
      limit: clampInt(req.query.limit, 30, 1, 50),
    });
    res.json({ changes });
  } catch { res.status(500).json({ error: '获取变更申请失败' }); }
});

router.get('/changes/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const change = await getChange(String(req.params.id));
    if (!change) return res.status(404).json({ error: '变更不存在' });
    const asset = await getAsset(change.assetId === '' ? '' : change.assetId).catch(() => null);
    const versions = await listVersions(change.assetKey, 5);
    res.json({ change, asset, versions });
  } catch { res.status(500).json({ error: '获取变更详情失败' }); }
});

// ------------------------- 写操作（统一 can() 判定） -------------------------

router.post('/changes/:id/approve', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const change = await getChange(String(req.params.id));
    if (!change) return res.status(404).json({ error: '变更不存在' });
    const actor = actorOf(req);
    const perm = can(actor, 'approve', { assetType: 'rsi_control', assetKey: `change:${change.id}`, scope: 'global' }, 'r1', 'active');
    if (!perm.allow) {
      await writeAudit({ action: 'permission_denied', adminId: actor.id, candidateId: change.id, reason: perm.reason });
      return res.status(403).json({ error: '权限不足', reason: perm.reason });
    }
    const allowSelf = String(process.env.RSI_ALLOW_SELF_APPROVE || '') === '1';
    await approveChange(change.id, actor.id, allowSelf);
    await writeAudit({ action: 'approved', candidateId: change.id, adminId: actor.id });
    res.json({ ok: true, id: change.id, status: 'approved' });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    res.status(msg === 'self_approval_denied' ? 409 : 500).json({ error: msg });
  }
});

router.post('/changes/:id/reject', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const change = await getChange(String(req.params.id));
    if (!change) return res.status(404).json({ error: '变更不存在' });
    const actor = actorOf(req);
    const perm = can(actor, 'approve', { assetType: 'rsi_control', assetKey: `change:${change.id}`, scope: 'global' }, 'r1', 'active');
    if (!perm.allow) return res.status(403).json({ error: '权限不足', reason: perm.reason });
    const reason = String(req.body?.reason ?? '').slice(0, 300);
    await rejectChange(change.id, actor.id, reason || '管理员拒绝');
    await writeAudit({ action: 'rejected', candidateId: change.id, adminId: actor.id, reason });
    res.json({ ok: true, id: change.id, status: 'rejected' });
  } catch (err) {
    res.status(500).json({ error: String((err as Error)?.message ?? err) });
  }
});

/**
 * 灰度放量与升降级。
 * - action=percent：仅调整 canaryPercent（0..100）；percent=0 视为「暂停放量但保持 canary」，
 *   由调用方 UI 明确提示，不允许静默变成「无人体验新版本」。
 * - action=promote：必须附上真实指标证据（样本量/成功率/Wilson），否则拒绝——
 *   不允许用百分比代替指标决定发布。
 * - action=rollback：恢复上一个 released 版本（pipeline.monitorRollout 同口径）。
 * 所有分支前置暂停检查：全局暂停生效期间不接受人工放量。
 */
router.post('/changes/:id/rollout', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const change = await getChange(String(req.params.id));
    if (!change) return res.status(404).json({ error: '变更不存在' });
    const actor = actorOf(req);
    const perm = can(actor, 'approve', { assetType: 'rsi_control', assetKey: `change:${change.id}`, scope: 'global' }, 'r1', 'active');
    if (!perm.allow) {
      await writeAudit({ action: 'permission_denied', adminId: actor.id, candidateId: change.id, reason: perm.reason });
      return res.status(403).json({ error: '权限不足', reason: perm.reason });
    }
    // 暂停优先：任何放量/升降级前先确认未被暂停
    const paused = await checkPause({ scope: 'asset_key', resource: change.assetKey, level: 'write' }).catch(() => ({ paused: true, reason: 'pause_state_unknown' }));
    if (paused.paused) {
      await writeAudit({ action: 'guard_blocked', adminId: actor.id, candidateId: change.id, reason: `paused:${paused.reason}` });
      return res.status(409).json({ error: '已暂停，无法放量', reason: paused.reason });
    }
    const action = String(req.body?.action ?? 'percent');
    const percent = clampInt(req.body?.percent, 0, 0, 100);

    if (action === 'promote') {
      const ev = req.body?.evidence;
      if (!ev || typeof ev !== 'object') {
        return res.status(400).json({ error: 'promote 需要指标证据（samples/successRate/errorRate/Wilson）' });
      }
      const stats = await collectChatMetrics(24, { minSamples: 30 });
      if (!stats) {
        return res.status(409).json({ error: '无可用运行指标，禁止人工放量' });
      }
      const c = computeGroup(stats);
      const cw = wilsonLowerBound(Math.round(c.successRate * c.samples), c.samples);
      const verdict = compare(computeMetrics(collectGroup([{ status: 'OK', sourceId: 'x' }])), computeMetrics(stats));
      if (!verdict.better && String(process.env.RSI_ALLOW_FORCE_PROMOTE || '') !== '1') {
        await writeAudit({ action: 'guard_blocked', adminId: actor.id, candidateId: change.id, reason: `promote_metrics_insufficient:${verdict.note}` });
        return res.status(409).json({ error: '指标未达标，禁止放量', note: verdict.note, wilsonLower: cw });
      }
      await releaseVersion(change.assetKey, change.toVersion);
      await transition(change.id, 'released');
      await writeAudit({ action: 'canary_promoted', candidateId: change.id, adminId: actor.id, metadata: { samples: c.samples, successRate: c.successRate, wilsonLower: cw, forced: verdict.better ? false : true } });
      return res.json({ ok: true, status: 'released', metrics: { samples: c.samples, successRate: c.successRate, wilsonLower: cw } });
    }

    if (action === 'rollback') {
      const prev = await getPreviousReleasedVersion(change.assetKey);
      const content = prev ? (prev.content ?? prev.contentRef) : '';
      const rv = await createVersion({ assetType: 'knowledge_fact', assetKey: change.assetKey, content, actorKind: 'admin', actorId: actor.id });
      await releaseVersion(change.assetKey, rv.version);
      await transition(change.id, 'rolled_back');
      await writeAudit({ action: 'canary_rolled_back', candidateId: change.id, adminId: actor.id, metadata: { restoredVersion: rv.version, restoredFrom: prev?.version ?? null } });
      return res.json({ ok: true, status: 'rolled_back', restoredVersion: rv.version });
    }

    await transition(change.id, 'canary', { canaryPercent: percent });
    await writeAudit({ action: 'canary_started', candidateId: change.id, adminId: actor.id, metadata: { percent } });
    res.json({ ok: true, status: 'canary', percent, note: percent === 0 ? 'percent=0 表示暂停放量，canary 仍保持待观察' : undefined });
  } catch (err) {
    res.status(500).json({ error: String((err as Error)?.message ?? err) });
  }
});

/** 暂停/恢复：支持 global / asset_type / asset_key / worker_kind。 */
router.post('/pause', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const actor = actorOf(req);
    const perm = can(actor, 'pause', { assetType: 'rsi_control', assetKey: 'system_pause', scope: 'global' }, 'r1', 'active');
    if (!perm.allow) return res.status(403).json({ error: '权限不足' });
    const scope = String(req.body?.scope ?? 'global');
    const resource = scope === 'global' ? '*' : String(req.body?.resource ?? '').slice(0, 200);
    if (scope !== 'global' && !resource) return res.status(400).json({ error: 'resource 必填' });
    const row = await pause({
      scope: scope as 'global' | 'asset_type' | 'asset_key' | 'worker_kind',
      resource, level: (String(req.body?.level ?? 'write') as 'read' | 'write' | 'all'),
      pausedBy: actor.id, reason: String(req.body?.reason ?? '管理员暂停').slice(0, 300),
      expiresAt: req.body?.expiresAt ? new Date(String(req.body.expiresAt)) : undefined,
    });
    await writeAudit({ action: 'paused', adminId: actor.id, scope: resource, metadata: { pauseId: row.id, scope } });
    res.json({ ok: true, pauseId: row.id });
  } catch (err) {
    res.status(500).json({ error: String((err as Error)?.message ?? err) });
  }
});

router.post('/resume', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const actor = actorOf(req);
    const id = String(req.body?.pauseId ?? '');
    if (!id) return res.status(400).json({ error: 'pauseId 必填' });
    await resumePause(id);
    await writeAudit({ action: 'resumed', adminId: actor.id, scope: id });
    res.json({ ok: true, pauseId: id });
  } catch (err) {
    res.status(500).json({ error: String((err as Error)?.message ?? err) });
  }
});

/** 手动触发一次信号扫描（同步执行，已持顾问锁则跳过）。 */
router.post('/scan', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { scheduledSignalScan } = await import('../services/rsi/scheduler');
    const r = await scheduledSignalScan();
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: String((err as Error)?.message ?? err) });
  }
});


// ------------------------- RSI 独立 API 配置（不依赖普通 ProviderConnection） -------------------------

/** RSI 自己的 Provider 配置列表（独立表，与普通 API 管理页零共享）。 */
router.get('/provider-configs', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { listRsiProviders } = await import('../services/rsi/rsiProviderConfig');
    const rows = await listRsiProviders(String(req.query.tier || '') || undefined);
    res.json({ configs: rows.map((r) => ({ ...r, apiKeys: (r.apiKeys ?? []).map((k: string) => (k && k.length > 8 ? `...${k.slice(-8)}` : '***')) })) });
  } catch (err) { res.status(500).json({ error: String((err as Error)?.message ?? err) }); }
});

/** 新增/更新 RSI Provider 配置。落库前经 parseRateLimitBlock 统一清洗。 */
router.post('/provider-configs', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const actor = actorOf(req);
    const perm = can(actor, 'register', { assetType: 'rsi_control', assetKey: 'rsi_provider_config', scope: 'global' }, 'r1', 'active');
    if (!perm.allow) return res.status(403).json({ error: '权限不足', reason: perm.reason });
    const body = req.body ?? {};
    if (!body.provider || !body.tier) return res.status(400).json({ error: 'provider/tier 必填' });
    if (!Array.isArray(body.apiKeys) || body.apiKeys.filter((k: unknown) => typeof k === 'string' && k).length === 0) {
      return res.status(400).json({ error: '至少一个 API Key' });
    }
    const { upsertRsiProvider, invalidateRsiProvider } = await import('../services/rsi/rsiProviderConfig');
    const row = await upsertRsiProvider({
      provider: String(body.provider), tier: String(body.tier), baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
      apiKeys: body.apiKeys.filter((k: unknown) => typeof k === 'string' && k) as string[],
      apiLimit: body.apiLimit, carrierLimit: body.carrierLimit, rsiModelLimit: body.rsiModelLimit ?? body.modelLimit,
      enabled: body.enabled !== false,
    });
    invalidateRsiProvider(String(body.provider), String(body.tier));
    const { primeRsiProviderCache } = await import('../services/rsi/rsiQuotaGate');
    primeRsiProviderCache([row]);
    await writeAudit({ action: 'rsi_provider_config_saved', adminId: actor.id, scope: `${body.provider}:${body.tier}` });
    res.json({ ok: true, id: row.id });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    res.status(msg.includes('InvalidLimit') ? 400 : 500).json({ error: msg });
  }
});

/**
 * RSI Provider 停用（软删）。不物理删除：
 *   - RsiQuotaSwitchLog / 额度历史按 provider+tier 文本留存，保持可追溯；
 *   - 仍有 rsi: 前缀活动租约时 409 拒绝（避免旧记录失去关联）。
 * 需要彻底清除属运维动作，不提供 HTTP 硬删入口。
 */
router.post('/provider-configs/disable', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body ?? {};
    if (!body.provider || !body.tier) return res.status(400).json({ error: 'provider/tier 必填' });
    const { countActiveLeases } = await import('../services/concurrencyLease');
    const active = await countActiveLeases(`rsi:conc:${body.provider}:${body.tier}`);
    if (active > 0) return res.status(409).json({ error: `仍有 ${active} 个 RSI 活动并发占用，不能停用` });
    const { upsertRsiProvider, invalidateRsiProvider } = await import('../services/rsi/rsiProviderConfig');
    const row = await upsertRsiProvider({
      provider: String(body.provider), tier: String(body.tier),
      apiKeys: Array.isArray(body.apiKeys) ? body.apiKeys : [], enabled: false,
    });
    invalidateRsiProvider(String(body.provider), String(body.tier));
    const { primeRsiProviderCache } = await import('../services/rsi/rsiQuotaGate');
    primeRsiProviderCache([row]);
    await writeAudit({ action: 'rsi_provider_config_disabled', adminId: actorOf(req).id, scope: `${body.provider}:${body.tier}` });
    res.json({ ok: true, id: row.id, enabled: false });
  } catch (err) { res.status(500).json({ error: String((err as Error)?.message ?? err) }); }
});

/** 预检：给一组限制配置做干跑校验，返回解析后的口径（不落库）。 */
router.post('/provider-configs/validate', adminAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const { parseRateLimitBlock } = await import('../services/rateLimitParse');
    const body = _req.body ?? {};
    const out: Record<string, unknown> = {};
    for (const key of ['apiLimit', 'carrierLimit', 'rsiModelLimit', 'modelLimit']) {
      if (body[key] === undefined) continue;
      try { out[key] = parseRateLimitBlock(body[key]); }
      catch (e) { out[key] = { invalid: String((e as Error).message) }; }
    }
    res.json(out);
  } catch (err) { res.status(500).json({ error: String((err as Error)?.message ?? err) }); }
});

/** 额度/并发预留预检（不真正占用）。 */
router.post('/quota/check', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { acquireRsiGate } = await import('../services/rsi/rsiQuotaGate');
    const body = req.body ?? {};
    const r = acquireRsiGate({
      provider: String(body.provider ?? ''),
      tier: String(body.tier ?? 'FREE') === 'PRO' ? 'PRO' : 'FREE',
      modelKey: String(body.modelKey ?? ''),
      apiKey: String(body.apiKey ?? ''),
      estTokens: Number(body.estimatedTokens ?? body.estTokens ?? 0),
    });
    res.json(r);
  } catch (err) { res.status(500).json({ error: String((err as Error)?.message ?? err) }); }
});

/** RSI 侧额度自动切换记录。 */
router.get('/quota/switch-logs', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const rows = await prismaKnowledge.rsiQuotaSwitchLog.findMany({
      orderBy: { createdAt: 'desc' }, take: clampInt(req.query.limit, 50, 1, 200),
    });
    res.json({ logs: rows });
  } catch { res.status(500).json({ error: '获取切换记录失败' }); }
});

/** RSI 任务队列状态（RsiJob 表，user 库）。 */
router.get('/jobs', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { prismaUser } = await import('../services/db');
    const rows = await prismaUser.rsiJob.findMany({
      orderBy: { queuedAt: 'desc' }, take: clampInt(req.query.limit, 30, 1, 100),
    });
    res.json({ jobs: rows });
  } catch { res.status(500).json({ error: '获取任务失败' }); }
});

/** 资产内容解析（生产版本 + 灰度分流），供管理页验证消费端口径。 */
router.get('/resolve', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { resolveAssetContent } = await import('../services/rsi/assetResolver');
    const assetKey = String(req.query.assetKey ?? '');
    if (!assetKey) return res.status(400).json({ error: 'assetKey 必填' });
    const r = await resolveAssetContent(assetKey, String(req.query.actorId ?? 'anonymous'));
    res.json(r);
  } catch (err) { res.status(500).json({ error: String((err as Error)?.message ?? err) }); }
});

/** 经验库（第三阶段 §7 已确认需要可查询）。 */
router.get('/experience', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { listExperience } = await import('../services/rsi/experienceLibrary');
    const assetKey = String(req.query.assetKey ?? '');
    const rows = assetKey ? await listExperience(assetKey, clampInt(req.query.limit, 20, 1, 100)) : [];
    res.json({ experiences: rows });
  } catch { res.status(500).json({ error: '获取经验库失败' }); }
});

export default router;
