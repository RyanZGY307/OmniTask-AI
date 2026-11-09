// Load .env into process.env before any config read. This module MUST
// import before ./config (which reads process.env at import time).
import './loadEnv';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config';

import authRoutes from './routes/auth';
import chatRoutes from './routes/chat';
import agentRoutes from './routes/agent';
import adminRoutes from './routes/admin';
import systemRoutes from './routes/system';
import { isDbSetupRequired } from './services/db';
import knowledgeRoutes from './routes/knowledge';
import paymentRoutes from './routes/payment';
import tokenRoutes from './routes/tokens';
import memoryRoutes from './routes/memory';
import feedbackRoutes from './routes/feedback';
import settingsRoutes from './routes/settings';
import currencyRoutes from './routes/currency';
import evolutionAdminRoutes from './routes/evolutionAdmin';
import adminObservabilityRoutes from './routes/adminObservability';
import userSkillsRoutes from './routes/userSkills';
import userProfileRoutes from './routes/userProfile';  // NEW
import connectionsRoutes from './routes/connections';
import providersRoutes from './routes/providers';
import actionsRoutes from './routes/actions';
import workspaceRoutes from './routes/workspace';  // 文件工作台（创建/读取/修改/目录/ZIP 下载）
import { devicesRouter, tasksRouter, browserRouter } from './routes/devices';
import modelsRoutes from './routes/models';
import { errorHandler } from './middleware/errorHandler';
import { startRateUpdater } from './services/exchangeRate';
import { initApiKeyPools } from './services/apiKeyPool';
import { startOrderCleanupJob } from './services/orderCleanup';
import { runCleanupCycle } from './services/logger';
import {
  wakeDatabase,
  ensureKnowledgeSchema,
  ensureUserSchema,
  ensureConversationSchema,
  ensureOverflowSchema,
  startKeepAlive,
} from './services/db';
import { initDynamicConfig } from './services/configSync';
import { seedDefaultScenarios } from './services/scenarioRegistry';
import { seedDefaultPromptAtoms, getActiveVersions } from './services/promptRegistry';
import { activeClientCount, pruneClients, touchClient } from './services/clientPresence';
import { initializeModelLimits } from './services/billing/modelLimits';
import { loadProviderConfigs } from './services/providerConfig';
import { bootstrapInitialPricingVersion, runDailyPricingJob } from './services/finance/pricingEngine';
import { seedProviderPricingFromEnv } from './services/finance/providerCosts';
import { prismaUser, prismaConversation, prismaKnowledge, prismaOverflow } from './services/db';
import pricingRoutes from './routes/pricing';
import { registerAllConnectors } from './connections/connectors';
import { initVault } from './connections/vault';
import importRoutes from './routes/import';
import expressionRoutes from './routes/expression';
import promptRoutes from './routes/prompt';
import { initWorkerPool } from './services/workerPool';
import rsiRoutes from './routes/rsiAdmin';
import { startRsiScheduler } from './services/rsi/scheduler';
import { listRsiProviders } from './services/rsi/rsiProviderConfig';
import { primeRsiProviderCache } from './services/rsi/rsiQuotaGate';
import { startMemoryCompressionWorker, stopMemoryCompressionWorker } from './services/memoryManager/worker';
import { cleanupSessions } from './services/sessionState';
import mediaRoutes from './routes/media';
import audioRoutes from './routes/audio';
import officeRoutes from './routes/office';

const app = express();

app.use(helmet());
// CLIENT_URL 支持逗号分隔多 origin（域名迁移过渡期新旧前端域共存）
const clientOrigins = (env.CLIENT_URL || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: env.CLIENT_URL === '*'
    ? true
    : clientOrigins.length === 1
      ? clientOrigins[0]
      : clientOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));

app.get('/health', (_, res) => res.json({ status: 'ok', version: '4.0.0-memory-runtime' }));

// ==================== API + DB Health (frontend connection gate) ====================
// /api/health verifies both that the API is alive AND that all 4 PostgreSQL
// datasources answer a ping within 5s. The frontend root layout polls this
// and withholds the whole UI until it returns ok.
//
// 待命连接：带 X-Client-Id 的探测同时登记客户端存活，db.startKeepAlive 据此
// 把 4 个池的保活从 60s 收紧到 15s；此处再预热提示词快照，让用户闲置几分钟后
// 发出的第一条消息不必冷查全部已发布 atom。
async function pingDb(client: any, timeoutMs = 5000): Promise<boolean> {
  try {
    await Promise.race([
      client.$queryRaw`SELECT 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error('db-ping-timeout')), timeoutMs)),
    ]);
    return true;
  } catch { return false; }
}

app.get('/api/health', async (req, res) => {
  // 前端可见标签页心跳带来的 per-tab id（见 client/src/hooks/useConnectionHealth.ts）。
  // 登记后 db.startKeepAlive 会把 4 个池的保活从 60s 收紧到 15s：用户在手，
  // 就不让池睡过去。无名探测（负载均衡/Render 探针）不产生存活记录。
  const clientId = String(req.headers['x-client-id'] || '').trim();
  if (clientId) touchClient(clientId);
  pruneClients();

  const [userOk, convOk, knowOk, overOk] = await Promise.all([
    pingDb(prismaUser), pingDb(prismaConversation), pingDb(prismaKnowledge), pingDb(prismaOverflow),
  ]);
  const ok = userOk && convOk && knowOk && overOk;

  // 待命：预热首条消息才会用到的提示词快照（TTL 缓存，最多每窗口一次查询）。
  // 少了它，用户闲置几分钟后发出的第一条消息仍要冷查全部已发布 atom。
  if (ok) {
    try { await getActiveVersions(); } catch { /* 预热失败不影响健康判定 */ }
  }

  res.status(ok ? 200 : 503).json({
    ok,
    dbs: { user: userOk, conversation: convOk, knowledge: knowOk, overflow: overOk },
    standby: { clients: activeClientCount() },
  });
});

// ================================================================
// Setup 守卫：连接串未配置时，除 /api/system 外全部 503 setupRequired。
// 必须挂在整个 /api 业务路由之前 —— 否则业务路由会连到 placeholder 库，
// 报错含糊，调用方容易误判为"数据库故障"而去重启、重连、查监控。
// 503 + setupRequired 让前端直接显示首次配置页。
// system 路由先于守卫挂载，否则 setup 端点自己也会被 503 挡掉。
// ================================================================
app.use('/api/system', systemRoutes);
// Controlled RSI admin API. Mounted BEFORE the DB-setup gate so the setup
// console can always inspect/act on the lifecycle layer once configured;
// every handler inside is authMiddleware + adminAuth guarded itself.
app.use('/api/rsi', rsiRoutes);
app.use('/api', (req: any, res: any, next: any) => {
  if (isDbSetupRequired()) {
    return res.status(503).json({
      error: '系统尚未配置数据库连接。请先在管理页面完成首次配置。',
      setupRequired: true,
    });
  }
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/import', importRoutes);
app.use('/api/admin/observability', adminObservabilityRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/skills', userSkillsRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/tokens', tokenRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/currency', currencyRoutes);
app.use('/api/evolution', evolutionAdminRoutes);
app.use('/api/user/profile', userProfileRoutes);  // NEW
app.use('/api/connections', connectionsRoutes);
app.use('/api/providers', providersRoutes);
app.use('/api/chat/audio', audioRoutes);  // Audio generation (TTS)
app.use('/api/actions', actionsRoutes);
app.use('/api/workspace', workspaceRoutes);  // 文件工作台：对话产物的真实文件能力
app.use('/api/devices', devicesRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/browser', browserRouter);
app.use('/api/models', modelsRoutes);
app.use('/api/expression', expressionRoutes);
app.use('/api/prompt', promptRoutes);
app.use('/api/chat/media', mediaRoutes);
app.use('/api/chat/office', officeRoutes);  // Office / Document generation

app.use(errorHandler);

async function startup() {
  // P0: In production a missing JWT_SECRET allows anyone to forge bearer tokens
  // (the dev default is a well-known constant). Fail fast, like VAULT_KEY.
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    console.error('[BOOT] FATAL: JWT_SECRET environment variable is required in production');
    process.exit(1);
  }

  console.log('[BOOT] Waking 4 Postgres databases (Layerbase poolers)...');
  const dbOk = await wakeDatabase(5);
  if (!dbOk) {
    console.error('[BOOT] One or more databases unreachable after retries. Continuing anyway.');
  }
  await ensureKnowledgeSchema().catch((err) =>
    console.error('[BOOT] Knowledge schema bootstrap error:', err),
  );
  await ensureUserSchema().catch((err) =>
    console.error('[BOOT] User schema bootstrap error:', err),
  );
  await ensureConversationSchema().catch((err) =>
    console.error('[BOOT] Conversation schema bootstrap error:', err),
  );
  await ensureOverflowSchema().catch((err) =>
    console.error('[BOOT] Overflow schema bootstrap error:', err),
  );
  // Keep all 4 poolers warm so a user hitting the UI after idle minutes
  // does not stall on a cold reconnect.
  startKeepAlive(60_000);

  // Load dynamic configuration from DB (models, packs, pricing)
  initDynamicConfig().catch((err) =>
    console.warn('[BOOT] Dynamic config init warning:', err),
  );
  await seedDefaultPromptAtoms().then((ids) => {
    if (ids.length > 0) console.log(`[BOOT] Seeded ${ids.length} default Prompt Atoms: ${ids.join(', ')}`);
  }).catch((err) =>
    console.warn('[BOOT] Prompt Atom seeding warning:', err),
  );
  seedDefaultScenarios().catch((err) =>
    console.warn('[BOOT] Scenario seeding warning:', err),
  );

  startRateUpdater();
  // Provider connections & API key pools from DB (admin-managed at
  // /admin/models). One-time env seed keeps existing deployments working
  // until keys are re-entered in the admin UI; env vars can then be removed.
  // Key pools must be built AFTER the connection load (they source keys
  // from it); on load failure fall back to an env-only pool build.
  loadProviderConfigs()
    .then(() => initApiKeyPools())
    .catch((err) => {
      console.warn('[BOOT] Provider config load warning, env fallback:', err?.message ?? err);
      initApiKeyPools();
    });
  startOrderCleanupJob();
  registerAllConnectors();
  // P0-10: Require VAULT_KEY in production ONLY. In dev, a missing key falls
  // back to the insecure JWT_SECRET-derived key (vault.ts) rather than
  // hard-exiting — a missing dev secret must not prevent startup.
  const isProd = process.env.NODE_ENV === 'production';
  try {
    initVault(isProd);
    if (!isProd && !process.env.VAULT_KEY) {
      console.warn('[BOOT] VAULT_KEY not set — dev mode uses insecure key derivation');
    }
  } catch (err: any) {
    console.error('[BOOT] Vault initialization failed:', err.message);
    process.exit(1);
  }

  // Dynamic pricing bootstrap + daily margin job (spec R3, R4, R5).
  // 冷启动错峰：等 10s 让数据库连接稳定 + 避开与用户请求抢锁，
  // 否则 P2028/P1008 会直接污染 /auth 路径。
  const BOOT_DELAY_MS = 10_000;
  setTimeout(() => {
    seedProviderPricingFromEnv().catch((err) =>
      console.warn('[PRICING] seedProviderPricingFromEnv warning:', err),
    );
    bootstrapInitialPricingVersion().then((r) => {
      if (r.ok) console.log(`[PRICING] active pricing version ${r.code}`);
    }).catch((err) => console.error('[PRICING] bootstrap error:', err));
  }, BOOT_DELAY_MS);

  // Model output-limit discovery: boot-time full check + 30-day refresh.
  // Runs at init ONLY — never in the request path. Staggered behind the
  // pricing bootstrap so it does not race database write locks at boot.
  //
  // NOTE: Node's 32-bit timer cap is 2_147_483_647 ms (2^31 - 1). A
  // 30-day (2_592_000_000) or even 29-day (2_505_600_000) interval
  // overflows and clamps to 1 ms, which turns a periodic refresh into a
  // "refresh every millisecond" hot loop that OOMs the process. Use 24
  // days (2_073_600_000 ms) to stay safely under the cap.
  const MODEL_LIMITS_REFRESH_MS = 24 * 24 * 60 * 60 * 1000; // 2_073_600_000
  setTimeout(() => {
    initializeModelLimits().catch((err) =>
      console.warn('[BOOT] Model limits init warning:', err),
    );
  }, BOOT_DELAY_MS / 2);
  setInterval(() => {
    initializeModelLimits().catch((err) =>
      console.warn('[ModelLimits] 30-day refresh warning:', err),
    );
  }, MODEL_LIMITS_REFRESH_MS);

  setInterval(() => {
    runDailyPricingJob().then((report) => {
      if (report.published) console.log(`[PRICING] published ${report.code}`);
    }).catch((err) => console.error('[PRICING] daily job error:', err));
  }, 24 * 60 * 60 * 1000);
  setTimeout(() => {
    runDailyPricingJob().catch((err) => console.error('[PRICING] startup job error:', err));
  }, 60000 + BOOT_DELAY_MS);

  setInterval(() => {
    runCleanupCycle().catch((err) => console.error('[CLEANUP] Error:', err));
  }, 6 * 60 * 60 * 1000);

  setTimeout(() => {
    runCleanupCycle().catch((err) => console.error('[CLEANUP] Startup cleanup error:', err));
  }, 30000);

  // Periodically prune in-memory agent sessions (memory-leak guard)
  setInterval(() => {
    cleanupSessions();
  }, 30 * 60 * 1000);

  // 对话记忆压缩派发器（与 worker pool 无关：任务表在 conversation 库）。
  // 启动时先恢复被中断的任务（进程重启不会丢失未完成的压缩）。
  startMemoryCompressionWorker();

  // Start knowledge research worker pool
  initWorkerPool({ maxConcurrency: parseInt(process.env.RESEARCH_MAX_CONCURRENCY || '5') }).catch((err) =>
    console.warn('[BOOT] Worker pool init warning:', err),
  );

  // Controlled RSI: signal scan (advisory-locked) + pause expiry + rollout monitor.
  // Disabled entirely by RSI_SCHEDULER=off; paused globally the scan no-ops.
  if (process.env.RSI_SCHEDULER !== 'off') {
    try {
      startRsiScheduler();
    } catch (err) {
      console.warn('[BOOT] RSI scheduler init warning:', err);
    }
  }

  // Knowledge self-repair lifecycle: periodic refresh scheduler. Enqueues
  // due RefreshTask rows; the worker pool (above) claims + executes them.
  // Bypassed entirely when KNOWLEDGE_LIFECYCLE_ENABLED=false.
  if (process.env.KNOWLEDGE_LIFECYCLE_ENABLED !== 'false') {
    const { runRefreshScheduler } = require('./services/knowledgeLifecycle/refreshScheduler');
    const REFRESH_TICK_MS = 10 * 60 * 1000; // 10 min
    setTimeout(() => {
      runRefreshScheduler(200).then((r: any) => {
        if (r?.dispatched) console.log(`[KNOWLEDGE-LIFECYCLE] refresh dispatch cycle=${r.cycle} dispatched=${r.dispatched} skipped=${r.skipped}`);
      }).catch((err: any) => console.warn('[KNOWLEDGE-LIFECYCLE] scheduler error:', err?.message ?? err));
    }, 30000);
    setInterval(() => {
      runRefreshScheduler(200).then((r: any) => {
        if (r?.dispatched) console.log(`[KNOWLEDGE-LIFECYCLE] refresh dispatch cycle=${r.cycle} dispatched=${r.dispatched} skipped=${r.skipped}`);
      }).catch((err: any) => console.warn('[KNOWLEDGE-LIFECYCLE] scheduler error:', err?.message ?? err));
    }, REFRESH_TICK_MS);
  }

  // 敏感标记落档的保留期清理：启动后立即跑一次，之后每 24h 一次。
  // 删除超过 retentionUntil 的 FlaggedConversation 行（默认 180 天，
  // 可用 SAFETY_FLAG_RETENTION_DAYS 调整）。
  const { cleanupExpiredFlags } = require('./services/sensitiveGuard');
  const runFlagCleanup = () => {
    cleanupExpiredFlags().then((n: number) => {
      if (n > 0) console.log(`[SAFETY] purged ${n} expired flagged conversations`);
    }).catch((err: any) => console.warn('[SAFETY] flag cleanup error:', err?.message ?? err));
  };
  setTimeout(runFlagCleanup, 60000);
  setInterval(runFlagCleanup, 24 * 60 * 60 * 1000);

  // ================================================================
  // 系统观测中心
  //   1) 采集：只读统计 → DbMetricSnapshot / DbStorageEntry（页面读缓存表，
  //      用户刷新页面不触发全表扫描）
  //   2) 摘要投影：只读既有任务表 → AiRunSummary（不改 core）
  //   3) 24h 清理：顾问锁多实例去重 + 分批物理删除，启动即跑 + 每分钟
  // ================================================================
  const obs = require('./services/observability/collector');
  const obsPurge = require('./services/observability/purge');
  const obsSummary = require('./services/observability/aiSummary');

  const OBS_COLLECT_MS = parseInt(process.env.OBS_COLLECT_INTERVAL_MS || '600000', 10);   // 10 min
  const OBS_STORAGE_MS = parseInt(process.env.OBS_STORAGE_INTERVAL_MS || '1800000', 10);  // 30 min
  const OBS_SUMMARY_MS = parseInt(process.env.OBS_SUMMARY_INTERVAL_MS || '300000', 10);   // 5 min

  if (process.env.OBSERVABILITY_ENABLED !== 'false') {
    try { obs.bindDomains(); } catch (err: any) { console.warn('[OBS] bindDomains warning:', err?.message ?? err); }
    try { obsPurge.startSummaryPurgeWorker(); } catch (err: any) { console.warn('[OBS] purge worker start warning:', err?.message ?? err); }

    // 启动即采一次，随后按频率；单库失败只记录，不影响其他库与其他调度
    setTimeout(() => {
      obs.collectMetrics()
        .then((r: any) => { if (r.failed > 0) console.warn(`[OBS] metrics collected ok=${r.captured} failed=${r.failed}`); })
        .catch((err: any) => console.warn('[OBS] collectMetrics error:', err?.message ?? err));
    }, 30000);

    setTimeout(() => {
      obs.collectStorageBreakdown()
        .then((r: any) => { if (r.failed > 0) console.warn(`[OBS] storage collected ok=${r.captured} failed=${r.failed}`); })
        .catch((err: any) => console.warn('[OBS] collectStorage error:', err?.message ?? err));
    }, 45000);

    setTimeout(() => {
      Promise.all([obsSummary.syncAiRunSummaries(), obsSummary.syncChatRunSummaries()])
        .catch((err: any) => console.warn('[OBS] summary sync error:', err?.message ?? err));
    }, 60000);

    setInterval(() => {
      obs.collectMetrics().catch((err: any) => console.warn('[OBS] collectMetrics error:', err?.message ?? err));
    }, OBS_COLLECT_MS);
    setInterval(() => {
      obs.collectStorageBreakdown().catch((err: any) => console.warn('[OBS] collectStorage error:', err?.message ?? err));
    }, OBS_STORAGE_MS);
    setInterval(() => {
      Promise.all([obsSummary.syncAiRunSummaries(), obsSummary.syncChatRunSummaries()])
        .catch((err: any) => console.warn('[OBS] summary sync error:', err?.message ?? err));
    }, OBS_SUMMARY_MS);

    console.log(`[OBS] 观测中心调度已注册：metrics=${OBS_COLLECT_MS}ms storage=${OBS_STORAGE_MS}ms summary=${OBS_SUMMARY_MS}ms purge=60s`);
  }

  // Controlled RSI: prime the sync quota-gate cache at boot (acquireRsiGate reads only this cache).
  listRsiProviders()
    .then((rows) => { primeRsiProviderCache(rows); console.log(`[RSI] provider cache primed rows=${rows.length}`); })
    .catch((err) => console.warn('[BOOT] RSI provider cache prime warning:', err));
  app.listen(env.PORT, () => console.log(`[BOOT] OmniTask server running on port ${env.PORT}`));
}

startup();