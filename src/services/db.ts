// ================================================================
// Database Client — 4-Postgres Architecture
// ================================================================
// Four independent Layerbase Postgres databases:
//   user         → DATABASE_URL_USER         (prismaUser)
//   conversation → DATABASE_URL_CONVERSATION (prismaConversation)
//   knowledge    → DATABASE_URL_KNOWLEDGE    (prismaKnowledge)
//   overflow     → DATABASE_URL_OVERFLOW     (prismaOverflow)
//
// Each Layerbase pooler can sleep; a first connect can stall 10-30s.
// wakeAll() + startKeepAlive() keep all 4 warm on boot and every
// minute so the pooler never drops a hot connection.
//
// `prisma` = prismaUser for backward compatibility.
// Schema managed by: prisma db push --schema prisma/schema-X.prisma
//
// Overflow routing: when a primary write to its owning datasource
// fails (P1001/P1017/unreachable), the app layer re-routes the row
// into the overflow DB's generic OverflowRow table and audits it.

import { PrismaClient as UserPrismaClient } from '@prisma/client-user';
import { PrismaClient as ConversationPrismaClient } from '@prisma/client-conversation';
import { PrismaClient as KnowledgePrismaClient } from '@prisma/client-knowledge';
import { PrismaClient as OverflowPrismaClient } from '@prisma/client-overflow';
import { getDbConnection, isSetupRequired, loadSystemConfigSync, type DbDomain } from './systemConfig';

type LogFlag = 'error' | 'warn' | 'info' | 'query';
function getLogFlags(): LogFlag[] {
  return process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'];
}

// Resolve the connection URL for a given domain.
//
// 来源已从「部署平台环境变量」改为「后端管理页维护的本地加密文件」
// （见 services/systemConfig.ts）。原因：环境变量对租户不可见、不可改、
// 不可审计，换库或换供应商端点必须重新部署。
//
// 未配置时**不在模块顶层 throw**——那会让进程起不来，从而永远打不开用来
// 填连接串的管理页。改为降级为 placeholder + setupRequired 标记，
// 由 middleware 把所有业务路由挡成 503 setupRequired。
function resolveDbUrl(domain: DbDomain): string {
  const fromFile = getDbConnection(domain);
  if (fromFile) return withPoolLimits(fromFile);

  // 仅一次性桥接：尚未落盘且环境变量齐全时播种配置，之后环境变量不再读取。
  // 已部署实例借此免于一次硬停机；这是全项目唯一仍会读到
  // DATABASE_URL_* 的地方，桥接完成后即可删除这些环境变量。
  const seeded = seedFromEnvOnce(domain);
  if (seeded) {
    console.warn(`[DB] ${domain} 连接串由环境变量一次性播种，稍后可删除该环境变量`);
    return withPoolLimits(seeded);
  }

  console.warn(`[DB] ${domain} 未配置 — 进入首次配置模式（setupRequired）`);
  return PLACEHOLDER_URL;
}

/** 端口 1 上没有任何东西：被误用会立刻连接失败，而不是静默连错库。 */
const PLACEHOLDER_URL = 'postgresql://placeholder:placeholder@127.0.0.1:1/placeholder';

function seedFromEnvOnce(domain: DbDomain): string | null {
  if (!isSetupRequired()) return null;   // 已有配置，绝不回退到环境变量
  const v = process.env[`DATABASE_URL_${domain.toUpperCase()}`];
  return v && v.trim() ? v.trim() : null;
}

/** true 表示尚未配置连接串，业务路由应全部挡下。 */
export function isDbSetupRequired(): boolean {
  return isSetupRequired() || !getDbConnection('user');
}

// Layerbase poolers refuse new clients once max_client_conn is reached
// ("FATAL: no more connections allowed"). Prisma's default pool size is
// CPUs*2+1 per client, and this process holds 4 clients, so without an
// explicit cap the pooler saturates and every query — including the auth
// lookup — starts failing. Callers can still override per-URL.
function withPoolLimits(url: string): string {
  if (/[?&]connection_limit=/.test(url)) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}connection_limit=5&pool_timeout=20`;
}

// 先加载本地配置；文件缺失时进入 setup 模式（见 resolveDbUrl 注释）。
// 必须同步完成：PrismaClient 在同一次模块求值中构造，异步加载必然晚于它。
loadSystemConfigSync();

const userUrl = resolveDbUrl('user');
const conversationUrl = resolveDbUrl('conversation');
const knowledgeUrl = resolveDbUrl('knowledge');
const overflowUrl = resolveDbUrl('overflow');

function logResolvedDbPaths(): void {
  for (const [label, url] of [
    ['user', userUrl],
    ['conversation', conversationUrl],
    ['knowledge', knowledgeUrl],
    ['overflow', overflowUrl],
  ] as const) {
    // Redact credentials in the log line.
    const redacted = url.replace(/:([^:@/]+)@/, ':<redacted>@');
    console.log(`[DB:${label}] Postgres (resolved=${redacted})`);
  }
}
logResolvedDbPaths();

const g = globalThis as unknown as {
  prismaUser?: UserPrismaClient;
  prismaConversation?: ConversationPrismaClient;
  prismaKnowledge?: KnowledgePrismaClient;
  prismaOverflow?: OverflowPrismaClient;
};

// All 4 datasources are Postgres. Use a longer transaction timeout
// (30000ms) so a slow first-connect after wake-up does not trip P2028.
export const prismaUser =
  g.prismaUser ||
  new UserPrismaClient({
    datasources: { db: { url: userUrl } },
    transactionOptions: { timeout: 30000, maxWait: 10000 },
    log: getLogFlags(),
  });

export const prismaConversation =
  g.prismaConversation ||
  new ConversationPrismaClient({
    datasources: { db: { url: conversationUrl } },
    transactionOptions: { timeout: 30000, maxWait: 10000 },
    log: getLogFlags(),
  });

export const prismaKnowledge =
  g.prismaKnowledge ||
  new KnowledgePrismaClient({
    datasources: { db: { url: knowledgeUrl } },
    transactionOptions: { timeout: 30000, maxWait: 10000 },
    log: getLogFlags(),
  });

export const prismaOverflow =
  g.prismaOverflow ||
  new OverflowPrismaClient({
    datasources: { db: { url: overflowUrl } },
    transactionOptions: { timeout: 30000, maxWait: 10000 },
    log: getLogFlags(),
  });

if (process.env.NODE_ENV !== 'production') {
  g.prismaUser = prismaUser;
  g.prismaConversation = prismaConversation;
  g.prismaKnowledge = prismaKnowledge;
  g.prismaOverflow = prismaOverflow;
}

// Backward compatibility: `prisma` = user DB
export const prisma = prismaUser;

// ================================================================
// Wake-up (Layerbase pooler sleep/wake)
// ================================================================
// Each Layerbase pooler sleeps when idle. A first connect can stall
// 10-30s until the pooler spins up. wakeAll() opens all 4 with a
// generous connection timeout and retries, so the boot path always
// ends in a warm, connected state.

const MAX_WAKE_RETRIES = 5;
const WAKE_RETRY_DELAY_MS = 8000;
const WAKE_CONNECT_TIMEOUT_MS = 45000;

type AnyPrisma = UserPrismaClient | ConversationPrismaClient | KnowledgePrismaClient | OverflowPrismaClient;

async function wakeOne(
  name: string,
  client: AnyPrisma,
  maxRetries = MAX_WAKE_RETRIES,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.$queryRaw`SELECT 1`;
      console.log(`[DB:${name}] connected (attempt ${attempt}/${maxRetries})`);
      return true;
    } catch (err: any) {
      const waitMs = attempt * WAKE_RETRY_DELAY_MS;
      console.warn(
        `[DB:${name}] connection failed (attempt ${attempt}/${maxRetries}): ${err?.code || ''} ${err?.message || err}. Retrying in ${waitMs}ms...`,
      );
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  console.error(`[DB:${name}] failed to connect after ${maxRetries} attempts`);
  return false;
}

export async function wakeDatabase(maxRetries = MAX_WAKE_RETRIES): Promise<boolean> {
  console.log('[DB] Opening 4 Postgres connections...');
  const [userOk, convOk, knowOk, overflowOk] = await Promise.all([
    wakeOne('user', prismaUser, maxRetries),
    wakeOne('conversation', prismaConversation, maxRetries),
    wakeOne('knowledge', prismaKnowledge, maxRetries),
    wakeOne('overflow', prismaOverflow, maxRetries),
  ]);
  return userOk && convOk && knowOk && overflowOk;
}

// ================================================================
// Keep-alive (prevent pooler sleep mid-session)
// ================================================================
// A periodic SELECT 1 on every datasource keeps each Layerbase
// pooler warm so a user hitting the UI after a few idle minutes
// does not stall on a cold reconnect. Call startKeepAlive() once
// at boot; it no-ops on the unref'd timer when the process exits.
//
// Presence-driven cadence (待命连接): while a frontend tab is live the
// backend tightens to KEEPALIVE_ACTIVE_MS (15s) so the first user message
// never meets a sleeping pooler; with nobody watching it relaxes back to
// the idle cadence, so an empty server does not burn queries. Live-ness is
// reported by the frontend heartbeat (X-Client-Id on /api/health) and is
// TTL-bounded — see clientPresence.ts.

import { activeClientCount, KEEPALIVE_ACTIVE_MS, KEEPALIVE_IDLE_MS } from './clientPresence';

let keepAliveTimer: NodeJS.Timeout | null = null;
let keepAliveStopped = false;

function pingAllDatasources(): void {
  for (const [name, client] of [
    ['user', prismaUser],
    ['conversation', prismaConversation],
    ['knowledge', prismaKnowledge],
    ['overflow', prismaOverflow],
  ] as const) {
    client
      .$queryRaw`SELECT 1`
      .then(() => {
        if (process.env.NODE_ENV === 'development') {
          console.log(`[DB:${name}] keep-alive OK`);
        }
      })
      .catch((err: any) => {
        console.warn(`[DB:${name}] keep-alive failed: ${err?.code || ''} ${err?.message || err}`);
      });
  }
}

export function startKeepAlive(
  idleIntervalMs: number = KEEPALIVE_IDLE_MS,
  activeIntervalMs: number = KEEPALIVE_ACTIVE_MS,
): void {
  if (keepAliveTimer) return;
  keepAliveStopped = false;

  const loop = () => {
    const liveClients = activeClientCount();
    pingAllDatasources();
    // Re-arm with the cadence this round earned, not a fixed one.
    keepAliveTimer = setTimeout(() => {
      keepAliveTimer = null;
      if (!keepAliveStopped) loop();
    }, liveClients > 0 ? activeIntervalMs : idleIntervalMs);
    // Don't hold the process open on shutdown.
    keepAliveTimer.unref?.();
  };

  loop();
  console.log(`[DB] keep-alive armed (presence-driven: ${activeIntervalMs / 1000}s while a frontend is live, ${idleIntervalMs / 1000}s idle, 4 datasources)`);
}

export function stopKeepAlive(): void {
  keepAliveStopped = true;
  if (keepAliveTimer) {
    clearTimeout(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// ================================================================
// Schema bootstrap
// ================================================================
// Each DB is independent; a health check on one does not imply the
// others are up. ensure* verifies the owning datasource answers.

export async function ensureKnowledgeSchema(): Promise<boolean> {
  try {
    await prismaKnowledge.$queryRaw`SELECT 1`;
    console.log('[DB:knowledge] schema OK');
    return true;
  } catch (err: any) {
    console.error('[DB:knowledge] schema check failed:', err?.message);
    console.log('[DB:knowledge] run: npx prisma db push --schema prisma/schema-knowledge.prisma');
    return false;
  }
}

export async function ensureUserSchema(): Promise<boolean> {
  try {
    await prismaUser.$queryRaw`SELECT 1`;
    console.log('[DB:user] schema OK');
    return true;
  } catch (err: any) {
    console.error('[DB:user] schema check failed:', err?.message);
    console.log('[DB:user] run: npx prisma db push --schema prisma/schema-user.prisma');
    return false;
  }
}

export async function ensureConversationSchema(): Promise<boolean> {
  try {
    await prismaConversation.$queryRaw`SELECT 1`;
    console.log('[DB:conversation] schema OK');
    return true;
  } catch (err: any) {
    console.error('[DB:conversation] schema check failed:', err?.message);
    console.log('[DB:conversation] run: npx prisma db push --schema prisma/schema-conversation.prisma');
    return false;
  }
}

export async function ensureOverflowSchema(): Promise<boolean> {
  try {
    await prismaOverflow.$queryRaw`SELECT 1`;
    console.log('[DB:overflow] schema OK');
    return true;
  } catch (err: any) {
    console.error('[DB:overflow] schema check failed:', err?.message);
    console.log('[DB:overflow] run: npx prisma db push --schema prisma/schema-overflow.prisma');
    return false;
  }
}

// ================================================================
// Overflow routing (write-side failover)
// ================================================================
// When a write to a primary datasource fails, re-route the row into
// the overflow DB's OverflowRow table and record the move in
// OverflowAudit. Reads still hit the primary DB; a re-home pass can
// later drain OverflowRow back into the primary.

export interface OverflowRouteResult {
  routed: boolean;
  overflowRowId?: string;
  reason?: string;
}

export async function routeOverflow(
  sourceDb: 'user' | 'conversation' | 'knowledge',
  sourceTable: string,
  payload: unknown,
  userId?: string,
  reason = 'primary write failed',
): Promise<OverflowRouteResult> {
  try {
    const row = await prismaOverflow.overflowRow.create({
      data: {
        sourceTable,
        sourceDb,
        payload: JSON.stringify(payload),
        userId: userId ?? null,
      },
    });
    await prismaOverflow.overflowAudit.create({
      data: {
        sourceTable,
        sourceDb,
        targetDb: 'overflow',
        reason,
        rowCount: 1,
      },
    });
    console.log(`[DB:overflow] routed ${sourceDb}.${sourceTable} (row=${row.id}, reason=${reason})`);
    return { routed: true, overflowRowId: row.id, reason };
  } catch (err: any) {
    // If even the overflow DB is down, we have nowhere to go. Surface
    // the original failure rather than swallowing it.
    console.error(`[DB:overflow] routing failed: ${err?.code || ''} ${err?.message || err}`);
    return { routed: false, reason: `overflow routing failed: ${err?.message || err}` };
  }
}

// Detect whether a Prisma error is a "datasource unreachable" failure
// (the trigger for overflow routing).
export function isDatasourceFailure(err: any): boolean {
  if (!err) return false;
  return (
    err?.code === 'P1001' ||
    err?.code === 'P1017' ||
    err?.code === 'P1012' ||
    (typeof err?.message === 'string' &&
      (err.message.includes("Can't reach database") ||
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('timeout') ||
        err.message.includes('disk full') ||
        err.message.includes('No space left')))
  );
}

// ================================================================
// Prisma Middleware — Auto Retry
// ================================================================

const RETRYABLE_CODES = ['P1001', 'P1017', 'P1012'];

// Transient connection failures seen from the Layerbase poolers: the pooler
// reaps idle clients (client_idle_timeout) and rejects new ones once
// max_client_conn is reached. Retrying after a short backoff recovers
// without surfacing the error.
const RETRYABLE_MESSAGE_PATTERNS = [
  "Can't reach database",
  'ECONNREFUSED',
  'timeout',
  'Connection terminated',
  'no more connections allowed',
  'max_client_conn',
  'client_idle_timeout',
];

function isRetryableError(err: any): boolean {
  if (RETRYABLE_CODES.includes(err?.code)) return true;
  const msg = typeof err?.message === 'string' ? err.message : '';
  return RETRYABLE_MESSAGE_PATTERNS.some((p) => msg.includes(p));
}

function addRetryMiddleware(client: AnyPrisma, name: string) {
  const useFn = (client as any).$use;
  if (typeof useFn !== 'function') return;
  useFn.call(
    client,
    async (params: any, next: any) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await next(params);
        } catch (err: any) {
          const isRetryable = isRetryableError(err);

          if (isRetryable && attempt < 3) {
            console.warn(`[DB:${name}] ${params.model}.${params.action} failed (attempt ${attempt}/3), retrying...`);
            await new Promise((r) => setTimeout(r, attempt * WAKE_RETRY_DELAY_MS));
            continue;
          }
          throw err;
        }
      }
    },
  );
}

addRetryMiddleware(prismaUser, 'user');
addRetryMiddleware(prismaConversation, 'conversation');
addRetryMiddleware(prismaKnowledge, 'knowledge');
addRetryMiddleware(prismaOverflow, 'overflow');

// ================================================================
// Message.seq 自动分配（conversation 库）
// ================================================================
// 对话记忆管理（压缩截止位置、"不误删压缩期间产生的新消息"）需要对话内单调
// 且唯一的序号。Message 原本只有 createdAt 与 cuid，cuid 非单调，故新增 seq
// 字段并由迁移回填历史行。
//
// 为什么在这里统一分配，而不是在每个 message.create 调用点写：
//   chat.ts 里有 14 处 message.create（媒体确认卡/音频卡/Office 卡/用户消息/
//   助手消息……）。逐处写既容易漏，也会让"序号分配规则"分散在 14 个地方 ——
//   本次任务要消除的正是这类不一致。
//
// 失败开放（fail-open）而非失败关闭：seq 分配不出去时仍然写入消息。
// 理由：丢一条用户消息是不可逆的真实损失；seq 缺失只让该对话暂时失去压缩
// 能力（buildModelContext 检测到 seq 不可用会降级，行为与接入前一致），
// 等迁移 backfill 即可恢复。两害相权，绝不牺牲消息保存。
// ================================================================

const SEQ_MAX_ALLOC_ATTEMPTS = 4;

function addMessageSeqMiddleware(client: ConversationPrismaClient) {
  const useFn = (client as any).$use;
  if (typeof useFn !== 'function') return;
  useFn.call(
    client,
    async (params: any, next: any) => {
      if (params.model !== 'Message' || params.action !== 'create') {
        return next(params);
      }
      const data = params.args?.data;
      // 调用方显式给了 seq 就尊重它（迁移回填/管理脚本用）
      if (!data || typeof data !== 'object' || typeof data.seq === 'number') {
        return next(params);
      }
      const conversationId: string | undefined =
        typeof data.conversationId === 'string' ? data.conversationId : undefined;
      if (!conversationId) return next(params);   // 无对话归属：无从分配

      for (let attempt = 1; attempt <= SEQ_MAX_ALLOC_ATTEMPTS; attempt++) {
        // 取该对话当前最大序号。这不是事务，两个并发请求可能拿到同值；
        // 唯一索引把后一个撞成 P2002，由下面的重试分支递增重读。
        const last = await (client as any).message.findFirst({
          where: { conversationId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        });
        const nextSeq = (last?.seq ?? 0) + attempt;
        data.seq = nextSeq;
        try {
          return await next(params);
        } catch (err: any) {
          // 唯一约束冲突 = 并发撞号：重读并递增
          if (err?.code === 'P2002' && attempt < SEQ_MAX_ALLOC_ATTEMPTS) {
            console.warn(`[DB:conversation] Message.seq 冲突 (${nextSeq})，重试 ${attempt}/${SEQ_MAX_ALLOC_ATTEMPTS}`);
            continue;
          }
          // 重试用尽仍冲突：清掉 seq，让消息本身仍能写入（失败开放）
          if (err?.code === 'P2002') delete data.seq;
          throw err;
        }
      }
      return next(params);
    },
  );
}

addMessageSeqMiddleware(prismaConversation);

// ================================================================
// Generic retry helper
// ================================================================

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  label = 'query',
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isConnectionError = isRetryableError(err);

      if (isConnectionError && attempt < maxRetries) {
        const waitMs = attempt * WAKE_RETRY_DELAY_MS;
        console.warn(`[DB] ${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${waitMs}ms...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}
