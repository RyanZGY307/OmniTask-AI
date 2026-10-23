import { Router, Response } from 'express';
import { authMiddleware, adminAuth, AuthRequest } from '../middleware/auth';
import { prisma } from '../services/db';

const router = Router();

router.use(authMiddleware, adminAuth);

router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const hours = parseInt(String(req.query.hours)) || 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const [
      totalRequests, successCount, failedCount,
      totalTokensResult, totalCreditsResult, totalCostResult, avgLatencyResult,
    ] = await Promise.all([
      prisma.requestTrace.count({ where: { createdAt: { gte: since } } }),
      prisma.requestTrace.count({ where: { createdAt: { gte: since }, status: 'SUCCESS' } }),
      prisma.requestTrace.count({ where: { createdAt: { gte: since }, status: { in: ['FAILED', 'TIMEOUT'] } } }),
      prisma.requestTrace.aggregate({ where: { createdAt: { gte: since } }, _sum: { totalTokens: true } }),
      prisma.billingTransaction.aggregate({ where: { createdAt: { gte: since }, reason: 'ai_usage' }, _sum: { amount: true } }),
      prisma.requestTrace.aggregate({ where: { createdAt: { gte: since } }, _sum: { totalApiCostUsd: true } }),
      prisma.requestTrace.aggregate({ where: { createdAt: { gte: since }, durationMs: { not: null } }, _avg: { durationMs: true } }),
    ]);

    const successRate = totalRequests > 0 ? (successCount / totalRequests * 100) : 100;
    const errorRate = totalRequests > 0 ? (failedCount / totalRequests * 100) : 0;

    const perModel = await prisma.requestTrace.groupBy({
      by: ['selectedModel'],
      where: { createdAt: { gte: since }, selectedModel: { not: null } },
      _count: { id: true },
      _sum: { totalTokens: true, totalApiCostUsd: true },
      _avg: { durationMs: true },
    });

    const perModelStats = await Promise.all(
      perModel.map(async (m) => {
        const failed = await prisma.requestTrace.count({
          where: { createdAt: { gte: since }, selectedModel: m.selectedModel, status: { in: ['FAILED', 'TIMEOUT'] } },
        });
        return {
          model: m.selectedModel,
          requests: m._count.id,
          totalTokens: m._sum.totalTokens || 0,
          totalCostUsd: m._sum.totalApiCostUsd || 0,
          avgLatencyMs: Math.round(m._avg.durationMs || 0),
          errorRate: m._count.id > 0 ? (failed / m._count.id * 100) : 0,
        };
      }),
    );

    res.json({
      period: `${hours}h`, totalRequests,
      successRate: Math.round(successRate * 10) / 10,
      errorRate: Math.round(errorRate * 10) / 10,
      totalTokens: totalTokensResult._sum.totalTokens || 0,
      totalCreditsUsed: Math.abs(totalCreditsResult._sum.amount || 0),
      totalApiCostUsd: totalCostResult._sum.totalApiCostUsd || 0,
      avgLatencyMs: Math.round(avgLatencyResult._avg.durationMs || 0),
      perModel: perModelStats,
    });
  } catch (err) {
    console.error('Observability stats error:', err);
    res.status(500).json({ error: '获取统计失败' });
  }
});

router.get('/traces', async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.model) where.selectedModel = { contains: String(req.query.model) };
    if (req.query.userId) where.userId = req.query.userId;
    if (req.query.conversationId) where.conversationId = req.query.conversationId;

    if (req.query.search) {
      const search = String(req.query.search);
      where.OR = [
        { id: { contains: search } },
        { requestId: { contains: search } },
        { selectedModel: { contains: search } },
      ];
    }

    if (req.query.from || req.query.to) {
      where.createdAt = {};
      if (req.query.from) where.createdAt.gte = new Date(String(req.query.from));
      if (req.query.to) where.createdAt.lte = new Date(String(req.query.to));
    }

    const [traces, total] = await Promise.all([
      prisma.requestTrace.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, requestId: true, userId: true, conversationId: true,
          createdAt: true, durationMs: true, status: true,
          selectedModel: true, provider: true, mode: true,
          totalTokens: true, inputTokens: true, outputTokens: true,
          creditsCharged: true, totalApiCostUsd: true,
          ttftMs: true, finishReason: true,
        },
      }),
      prisma.requestTrace.count({ where }),
    ]);

    res.json({ traces, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Traces list error:', err);
    res.status(500).json({ error: '获取请求列表失败' });
  }
});

router.get('/traces/:id', async (req: AuthRequest, res: Response) => {
  try {
    const trace = await prisma.requestTrace.findUnique({
      where: { id: String(req.params.id) },
      include: {
        events: { orderBy: { timestamp: 'asc' } },
        modelCalls: true,
        toolCalls: true,
        errors: true,
        billingTransactions: true,
      },
    });

    if (!trace) return res.status(404).json({ error: 'Trace not found' });
    res.json({ trace });
  } catch (err) {
    console.error('Trace detail error:', err);
    res.status(500).json({ error: '获取请求详情失败' });
  }
});

router.get('/errors', async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
    const skip = (page - 1) * limit;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const where: any = { createdAt: { gte: since } };
    if (req.query.severity) where.severity = req.query.severity;
    if (req.query.stage) where.stage = req.query.stage;
    if (req.query.errorType) where.errorType = req.query.errorType;

    const [errors, total] = await Promise.all([
      prisma.errorLog.findMany({
        where, skip, take: limit,
        orderBy: { timestamp: 'desc' },
        include: { trace: { select: { id: true, selectedModel: true, userId: true } } },
      }),
      prisma.errorLog.count({ where }),
    ]);

    res.json({ errors, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Errors list error:', err);
    res.status(500).json({ error: '获取错误列表失败' });
  }
});

router.get('/billing', async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
    const skip = (page - 1) * limit;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const where: any = { createdAt: { gte: since } };
    if (req.query.userId) where.userId = req.query.userId;
    if (req.query.model) where.model = String(req.query.model);

    const [transactions, total] = await Promise.all([
      prisma.billingTransaction.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.billingTransaction.count({ where }),
    ]);

    res.json({ transactions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Billing list error:', err);
    res.status(500).json({ error: '获取计费列表失败' });
  }
});

// ================================================================
// 系统观测中心（System Observability Center）
// 全部只读：不暴露连接串、不提供任意 SQL 执行、不改变数据库状态。
// 权限沿用本文件顶部 router.use(authMiddleware, adminAuth)。
// ================================================================
import {
  listDomains, bindDomains,
} from '../services/observability/collector';
import {
  ACTIVE_SUMMARY_FILTER, clampInt, parseIsoOrNull, remainingSeconds, redact,
  staleness, toJsonNumber, utilizationPercent, aggregateInstances, jsonSafe,
} from '../services/observability/pgStats';

const JOB_TABLES: { kind: string; delegate: string }[] = [
  { kind: 'research', delegate: 'researchJob' },
  { kind: 'organization', delegate: 'organizationJob' },
  { kind: 'evolution', delegate: 'evolutionJob' },
  { kind: 'refresh', delegate: 'refreshTask' },
  { kind: 'skillAnalysis', delegate: 'skillAnalysisJob' },
  { kind: 'modelProfile', delegate: 'modelProfileJob' },
  { kind: 'contextCompression', delegate: 'contextCompressionJob' },
  { kind: 'verification', delegate: 'verificationJob' },
];

function aiTaskBuckets(rows: { status: string }[]) {
  const b = { running: 0, queued: 0, verifying: 0, failed: 0, completed: 0 };
  for (const r of rows) {
    const s = String(r.status || '').toUpperCase();
    if (s === 'RUNNING' || s === 'SCANNING' || s === 'COLLECTING' || s === 'VALIDATING'
      || s === 'ORGANIZING' || s === 'WRITING' || s === 'PROPOSING' || s === 'MERGING'
      || s === 'APPLYING' || s === 'PENDING') b.running++;
    else if (s === 'QUEUED') b.queued++;
    else if (s === 'VERIFYING' || s === 'VERIFY') b.verifying++;
    else if (s === 'FAILED' || s === 'TIMEOUT' || s === 'CANCELLED') b.failed++;
    else if (s === 'COMPLETED' || s === 'SUCCESS' || s === 'DONE') b.completed++;
  }
  return b;
}

async function collectJobStatusRows(now: Date) {
  const out: { status: string }[] = [];
  const day = 24 * 3600 * 1000;
  for (const t of JOB_TABLES) {
    try {
      const rows = await (prisma as any)[t.delegate].findMany({
        where: {
          OR: [
            { status: { in: ['QUEUED', 'RUNNING', 'SCANNING', 'COLLECTING', 'VALIDATING', 'ORGANIZING', 'WRITING', 'PROPOSING', 'MERGING', 'APPLYING', 'VERIFYING'] } },
            { updatedAt: { gte: new Date(now.getTime() - day) } },
          ],
        },
        take: 200, select: { status: true },
      });
      out.push(...rows);
    } catch { /* 单源失败不影响总览其他指标 */ }
  }
  return out;
}

/* ---------- 3.1 运行总览 ---------- */
router.get('/overview', async (req: AuthRequest, res: Response) => {
  const now = new Date();
  try {
    const domains = (() => { if (!listDomains().length) bindDomains(); return listDomains(); })();

    const [latestPerDomain, jobRows, criticalEvents, lastPurge] = await Promise.all([
      Promise.all(domains.map(async (d) =>
        (prisma as any).dbMetricSnapshot.findFirst({
          where: { domain: d.domain }, orderBy: { capturedAt: 'desc' },
        }))),
      collectJobStatusRows(now),
      prisma.obsEvent.findMany({
        where: { severity: { in: ['critical', 'error'] }, resolved: false },
        orderBy: { ts: 'desc' }, take: 5,
        select: { id: true, ts: true, kind: true, severity: true, title: true, domain: true, status: true },
      }),
      prisma.summaryPurgeLog.findFirst({ where: { mode: { in: ['boot', 'periodic'] } }, orderBy: { startedAt: 'desc' } }),
    ]);

    const rows = latestPerDomain.filter(Boolean) as any[];
    const registered = domains.length;
    const available = rows.filter((r) => r.connectionStatus === 'available').length;
    const unavailable = rows.filter((r) => r.connectionStatus === 'unavailable').length;
    const unknown = registered - rows.length;

    const lastCapturedAt = rows.length
      ? rows.map((r) => new Date(r.capturedAt)).sort((a, b) => b.getTime() - a.getTime())[0]
      : null;
    const st = staleness(lastCapturedAt, now);

    // 逻辑占用可相加；实例级指标按 instanceId 去重后只算一次
    const agg = aggregateInstances(rows.map((r) => ({
      instanceId: r.instanceId ?? null,
      sizeBytes: Number(r.sizeBytes ?? 0),
      instanceDiskUsedBytes: toJsonNumber(r.instanceDiskUsedBytes) as number | null,
      instanceDiskTotalBytes: toJsonNumber(r.instanceDiskTotalBytes) as number | null,
      instanceDiskAvailableBytes: toJsonNumber(r.instanceDiskAvailableBytes) as number | null,
    })));

    const instUsed = agg.instances.length
      ? agg.instances[0].usedBytes
      : (rows[0] ? toJsonNumber(rows[0].instanceDiskUsedBytes) as number | null : null);
    const instTotal = agg.instances.length ? agg.instances[0].totalBytes : null;
    const instAvail = agg.instances.length ? agg.instances[0].availableBytes : null;

    res.json(jsonSafe({
      generatedAt: now,
      lastCollectedAt: lastCapturedAt,
      collectionAgeSeconds: st.ageSeconds,
      stale: st.stale,
      databases: { registered, available, unavailable, unknown },
      totals: {
        logicalSizeBytes: toJsonNumber(agg.totalLogicalBytes),
        unit: 'bytes',
        basis: '各库 pg_database_size 之和（数据库逻辑占用）',
      },
      instance: {
        instanceCount: agg.instances.length,
        diskUsedBytes: toJsonNumber(instUsed),
        diskTotalBytes: toJsonNumber(instTotal),
        diskAvailableBytes: toJsonNumber(instAvail),
        utilizationPercent: utilizationPercent(instUsed as number | null, instTotal as number | null),
        capacitySource: instTotal === null ? 'unknown' : 'platform',
        note: instTotal === null
          ? '容量不可获取：托管平台未提供实例磁盘总容量指标，未用数据库大小顶替'
          : '实例级指标已按 instanceId 去重，共享实例只统计一次',
      },
      aiTasks: aiTaskBuckets(jobRows),
      criticalEvents: { count: criticalEvents.length, items: criticalEvents },
      purge: {
        lastRunAt: lastPurge?.startedAt ?? null,
        lastDeletedCount: lastPurge ? Number(lastPurge.deletedCount) : 0,
        latencyMs: lastPurge ? Number(lastPurge.latencyMs) : null,
        lastMode: lastPurge?.mode ?? null,
      },
    }));
  } catch (err: any) {
    console.error('[OBS] overview error:', err?.message || err);
    res.status(500).json({ error: '获取运行总览失败' });
  }
});

/* ---------- 3.2 数据库详情 ---------- */
router.get('/databases', async (req: AuthRequest, res: Response) => {
  try {
    const domains = (() => { if (!listDomains().length) bindDomains(); return listDomains(); })();
    const latest = await Promise.all(domains.map(async (d) =>
      (prisma as any).dbMetricSnapshot.findFirst({ where: { domain: d.domain }, orderBy: { capturedAt: 'desc' } })));

    const before24h = new Date(Date.now() - 24 * 3600 * 1000);
    const items = await Promise.all(domains.map(async (d, i) => {
      const s: any = latest[i] ?? null;
      const prev = await (prisma as any).dbMetricSnapshot.findFirst({
        where: { domain: d.domain, connectionStatus: 'available', capturedAt: { lte: before24h } },
        orderBy: { capturedAt: 'desc' }, select: { sizeBytes: true },
      });
      const size = s?.sizeBytes != null ? Number(s.sizeBytes) : null;
      const growth = size !== null && prev?.sizeBytes != null ? size - Number(prev.sizeBytes) : null;
      const used = s?.instanceDiskUsedBytes != null ? Number(s.instanceDiskUsedBytes) : null;
      const total = s?.instanceDiskTotalBytes != null ? Number(s.instanceDiskTotalBytes) : null;
      const avail = s?.instanceDiskAvailableBytes != null ? Number(s.instanceDiskAvailableBytes) : null;
      return {
        domain: d.domain, dbName: d.dbName,
        connectionStatus: s?.connectionStatus ?? 'unknown',
        sizeBytes: toJsonNumber(size),
        growthBytes24h: toJsonNumber(growth),
        schemaCount: s?.schemaCount ?? null,
        tableCount: s?.tableCount ?? null,
        instanceId: s?.instanceId ?? null,
        instanceDiskUsedBytes: toJsonNumber(used),
        instanceDiskTotalBytes: toJsonNumber(total),
        instanceDiskAvailableBytes: toJsonNumber(avail),
        instanceCapacitySource: total === null ? 'unknown' : 'platform',
        utilizationPercent: utilizationPercent(used, total),
        availableBytesBasis: avail === null ? '未知：无可靠数据来源' : '可用空间由托管平台指标提供',
        lastCapturedAt: s?.capturedAt ?? null,
        errorCode: s?.errorCode ?? null,
        unit: 'bytes',
      };
    }));

    res.json(jsonSafe({ generatedAt: new Date(), databases: items }));
  } catch (err: any) {
    console.error('[OBS] databases error:', err?.message || err);
    res.status(500).json({ error: '获取数据库列表失败' });
  }
});

/* ---------- 3.3 维度 B：按库/Schema/表 ---------- */
router.get('/databases/:domain/storage', async (req: AuthRequest, res: Response) => {
  try {
    const domain = String(req.params.domain || '');
    const domains = (() => { if (!listDomains().length) bindDomains(); return listDomains(); })();
    if (!domains.find((d) => d.domain === domain)) {
      return res.status(400).json({ error: '未登记的数据库 domain' });
    }
    const entries = await prisma.dbStorageEntry.findMany({
      where: { domain },
      orderBy: { capturedAt: 'desc' }, take: 600,
      select: { captureId: true, capturedAt: true, schemaName: true, tableName: true, objectKind: true,
        sizeBytes: true, rowEstimate: true, businessCategory: true, categoryConfidence: true, categoryEvidence: true },
    });
    if (!entries.length) {
      return res.json(jsonSafe({ generatedAt: new Date(), entries: [],
        unclassifiedBytes: 0, note: '尚无存储明细采集，请确认采集调度已运行' }));
    }
    const captureId = entries[0].captureId;
    const perCapture = entries.filter((e) => e.captureId === captureId);
    // 按表聚合 table/index/toast 三分，并附占比
    const byTable = new Map<string, any>();
    for (const e of perCapture) {
      const key = `${e.schemaName}.${e.tableName}`;
      const cur = byTable.get(key) ?? { schemaName: e.schemaName, tableName: e.tableName,
        tableBytes: 0, indexBytes: 0, toastBytes: 0, totalBytes: 0, rowEstimate: null,
        businessCategory: e.businessCategory, categoryConfidence: e.categoryConfidence, categoryEvidence: e.categoryEvidence };
      if (e.objectKind === 'table') cur.tableBytes += Number(e.sizeBytes);
      else if (e.objectKind === 'index') cur.indexBytes += Number(e.sizeBytes);
      else cur.toastBytes += Number(e.sizeBytes);
      cur.totalBytes += Number(e.sizeBytes);
      if (e.rowEstimate != null) cur.rowEstimate = Number(e.rowEstimate);
      byTable.set(key, cur);
    }
    const totalBytes = [...byTable.values()].reduce((a, b) => a + b.totalBytes, 0);
    const entriesOut = [...byTable.values()]
      .sort((a, b) => b.totalBytes - a.totalBytes)
      .map((t) => ({ ...t, percent: totalBytes > 0 ? Math.round((t.totalBytes / totalBytes) * 10000) / 100 : 0 }));

    res.json(jsonSafe({
      generatedAt: new Date(), captureId, capturedAt: perCapture[0].capturedAt, entries: entriesOut,
      unclassifiedBytes: entriesOut.filter((t) => t.businessCategory === 'unclassified').reduce((a, b) => a + b.totalBytes, 0),
      unclassifiedNote: '待识别：无命名/代码证据可归属，已单列而非强行归类',
      basis: 'total = table + index + toast 三分之和，互不重叠',
    }));
  } catch (err: any) {
    console.error('[OBS] storage error:', err?.message || err);
    res.status(500).json({ error: '获取存储明细失败' });
  }
});

/* ---------- 3.3 存储分类汇总 ---------- */
router.get('/storage/categories', async (req: AuthRequest, res: Response) => {
  try {
    const domains = (() => { if (!listDomains().length) bindDomains(); return listDomains(); })();
    const window = clampInt(req.query.window, 24, 1, 24 * 30);
    const since = new Date(Date.now() - window * 3600 * 1000);
    const rows = await prisma.dbStorageEntry.findMany({
      where: { createdAt: { gte: since } }, take: 3000,
      select: { domain: true, dbName: true, schemaName: true, tableName: true, objectKind: true,
        sizeBytes: true, businessCategory: true, createdAt: true, captureId: true },
    });
    if (!rows.length) {
      return res.json(jsonSafe({ generatedAt: new Date(), window: `${window}h`, empty: true,
        note: '尚无存储明细采集' }));
    }
    const byDb = new Map<string, number>(), byCat = new Map<string, number>(),
      bySchema = new Map<string, number>(), byKind = new Map<string, number>(),
      byTable = new Map<string, number>();
    for (const r of rows) {
      const n = Number(r.sizeBytes);
      byDb.set(r.dbName, (byDb.get(r.dbName) ?? 0) + n);
      byCat.set(r.businessCategory, (byCat.get(r.businessCategory) ?? 0) + n);
      bySchema.set(`${r.dbName}/${r.schemaName}`, (bySchema.get(`${r.dbName}/${r.schemaName}`) ?? 0) + n);
      byKind.set(r.objectKind, (byKind.get(r.objectKind) ?? 0) + n);
      byTable.set(`${r.dbName}.${r.schemaName}.${r.tableName}`, (byTable.get(`${r.dbName}.${r.schemaName}.${r.tableName}`) ?? 0) + n);
    }
    const grand = [...byDb.values()].reduce((a, b) => a + b, 0) || 1;
    const pct = (n: number) => Math.round((n / grand) * 10000) / 100;

    // 增长：同一 captureId 内最新与最早 capture 的差（窗口内）
    const caps = [...new Set(rows.map((r) => r.captureId))];
    const growthByTable = new Map<string, number>();
    if (caps.length > 1) {
      const firstCap = caps[caps.length - 1], lastCap = caps[0];
      const sum = (cap: string) => {
        const m = new Map<string, number>();
        for (const r of rows.filter((x) => x.captureId === cap)) {
          m.set(`${r.dbName}.${r.schemaName}.${r.tableName}`, (m.get(`${r.dbName}.${r.schemaName}.${r.tableName}`) ?? 0) + Number(r.sizeBytes));
        }
        return m;
      };
      const f = sum(firstCap), l = sum(lastCap);
      for (const [k, v] of l) growthByTable.set(k, v - (f.get(k) ?? 0));
    }

    const topTables = [...byTable.entries()].map(([table, bytes]) => ({
      table, bytes, percent: pct(bytes), growthBytes: growthByTable.get(table) ?? null,
    })).sort((a, b) => b.bytes - a.bytes).slice(0, 15);

    res.json(jsonSafe({
      generatedAt: new Date(), window: `${window}h`, basis: `最近一次采集（captureId=${caps[0]}）`,
      byDomain: [...byCat.entries()].map(([key, bytes]) => ({ key, bytes, percent: pct(bytes) })).sort((a, b) => b.bytes - a.bytes),
      byDatabase: [...byDb.entries()].map(([dbName, bytes]) => ({ dbName, bytes, percent: pct(bytes) })).sort((a, b) => b.bytes - a.bytes),
      bySchema: [...bySchema.entries()].map(([key, bytes]) => ({ key, bytes, percent: pct(bytes) })).sort((a, b) => b.bytes - a.bytes),
      topTables,
      byPhysicalType: ['table', 'index', 'toast'].map((kind) => ({
        kind, bytes: byKind.get(kind) ?? 0, percent: pct(byKind.get(kind) ?? 0),
        note: kind === 'table' ? '仅表自身数据，不含索引与 TOAST'
          : kind === 'toast' ? 'TOAST 用 total-table-index 差额法，与 table/index 无重叠' : '该表全部索引',
      })),
      unclassified: {
        bytes: byCat.get('unclassified') ?? 0,
        percent: pct(byCat.get('unclassified') ?? 0),
        note: '待识别：无证据可归属，单列展示',
      },
      totalBytes: grand,
    }));
  } catch (err: any) {
    console.error('[OBS] categories error:', err?.message || err);
    res.status(500).json({ error: '获取存储分类失败' });
  }
});

/* ---------- 3.4 AI 决策与执行（24h 过滤） ---------- */
router.get('/ai-runs', async (req: AuthRequest, res: Response) => {
  try {
    const limit = clampInt(req.query.limit, 20, 1, 100);
    const before = parseIsoOrNull(req.query.before);
    const taskKind = req.query.taskKind ? String(req.query.taskKind) : null;
    if (!listDomains().length) bindDomains();

    const where: any = { expiresAt: { gt: new Date() } };   // ← 24h 硬过滤
    if (before) where.createdAt = { lt: before };
    if (taskKind) where.taskKind = { in: taskKind.split(',').filter(Boolean) };

    const rows = await prisma.aiRunSummary.findMany({
      where, orderBy: { createdAt: 'desc' }, take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r: any) => ({
      id: r.id, taskId: r.taskId, taskKind: r.taskKind, status: r.status,
      createdAt: r.createdAt, expiresAt: r.expiresAt, remainingSeconds: remainingSeconds(r.expiresAt),
      triggerSource: r.triggerSource, agentName: r.agentName, modelUsed: r.modelUsed,
      goal: r.goal, summary: r.summary,
      decision: safeJson(r.decisionJson),
      guard: r.guardJson ? safeJson(r.guardJson) : { available: false, reason: '程序化安全门禁未接入' },
      tools: safeJson(r.toolsJson),
      outcome: safeJson(r.outcomeJson),
      startedAt: r.startedAt, completedAt: r.completedAt,
      redactionApplied: String(r.redactionApplied || '').split(',').filter(Boolean),
      relatedTraceIds: r.taskKind === 'chat' ? [r.taskId] : [],
    }));

    res.json(jsonSafe({
      generatedAt: new Date(), items,
      nextCursor: hasMore ? items[items.length - 1].createdAt : null,
      retention: { hours: 24, note: '摘要仅保留 24 小时，过期由后台任务物理删除' },
    }));
  } catch (err: any) {
    console.error('[OBS] ai-runs error:', err?.message || err);
    res.status(500).json({ error: '获取 AI 运行摘要失败' });
  }
});

router.get('/ai-runs/:id', async (req: AuthRequest, res: Response) => {
  try {
    const row: any = await prisma.aiRunSummary.findUnique({ where: { id: String(req.params.id) } });
    // 过期即拒：不返回正文（物理删除是兜底，这里是第一道闸）
    if (!row) return res.status(404).json({ error: '摘要不存在或已被清理' });
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      return res.status(404).json({ error: 'summary_expired', retentionHours: 24 });
    }
    res.json(jsonSafe({
      generatedAt: new Date(),
      run: {
        id: row.id, taskId: row.taskId, taskKind: row.taskKind, status: row.status,
        createdAt: row.createdAt, expiresAt: row.expiresAt, remainingSeconds: remainingSeconds(row.expiresAt),
        triggerSource: row.triggerSource, agentName: row.agentName, modelUsed: row.modelUsed,
        goal: row.goal, summary: row.summary,
        decision: safeJson(row.decisionJson), guard: safeJson(row.guardJson),
        tools: safeJson(row.toolsJson), outcome: safeJson(row.outcomeJson),
        startedAt: row.startedAt, completedAt: row.completedAt,
        redactionApplied: String(row.redactionApplied || '').split(',').filter(Boolean),
      },
      related: {
        traceIds: row.taskKind === 'chat' ? [row.taskId] : [],
        purgeLogs: await prisma.summaryPurgeLog.count({ where: { mode: { in: ['boot', 'periodic'] } } }),
      },
    }));
  } catch (err: any) {
    console.error('[OBS] ai-run detail error:', err?.message || err);
    res.status(500).json({ error: '获取摘要详情失败' });
  }
});

/* ---------- 3.5 事件与异常审计 ---------- */
router.get('/events', async (req: AuthRequest, res: Response) => {
  try {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const before = parseIsoOrNull(req.query.before);
    const severity = req.query.severity ? String(req.query.severity) : null;
    const kind = req.query.kind ? String(req.query.kind) : null;
    const where: any = {};
    if (severity) where.severity = { in: severity.split(',').filter(Boolean) };
    if (kind) where.kind = { in: kind.split(',').filter(Boolean) };
    if (before) where.ts = { lt: before };
    const rows = await prisma.obsEvent.findMany({
      where, orderBy: { ts: 'desc' }, take: limit + 1,
    });
    const hasMore = rows.length > limit;
    res.json(jsonSafe({
      generatedAt: new Date(), items: rows.slice(0, limit).map((r: any) => ({
        id: r.id, ts: r.ts, kind: r.kind, severity: r.severity, title: r.title,
        detail: r.detail, taskId: r.taskId, taskKind: r.taskKind, domain: r.domain,
        status: r.status, resolved: r.resolved, payloadRef: r.payloadRef,
      })),
      nextCursor: hasMore ? rows[limit - 1].ts : null,
    }));
  } catch (err: any) {
    console.error('[OBS] events error:', err?.message || err);
    res.status(500).json({ error: '获取事件列表失败' });
  }
});

/* ---------- 清理审计（验收 8/13 的证据） ---------- */
router.get('/purge', async (req: AuthRequest, res: Response) => {
  try {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const rows = await prisma.summaryPurgeLog.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
    res.json(jsonSafe({
      generatedAt: new Date(), items: rows.map((r: any) => ({
        id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, mode: r.mode,
        scannedCount: Number(r.scannedCount), expiredFound: Number(r.expiredFound),
        deletedCount: Number(r.deletedCount), failedCount: Number(r.failedCount),
        latencyMs: Number(r.latencyMs), leaseAcquired: r.leaseAcquired, errorMessage: r.errorMessage,
      })),
      note: 'latencyMs 为单轮清理耗时；删除后 OS 层空间由 autovacuum 回收复用，不即时缩小文件',
    }));
  } catch (err: any) {
    console.error('[OBS] purge log error:', err?.message || err);
    res.status(500).json({ error: '获取清理记录失败' });
  }
});

function safeJson(raw: unknown): any {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') return raw;
  try {
    const v = JSON.parse(raw);
    const rr = redact(JSON.stringify(v));
    return rr.text;
  } catch { return raw; }
}

export default router;