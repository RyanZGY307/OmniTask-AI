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

type LogFlag = 'error' | 'warn' | 'info' | 'query';
function getLogFlags(): LogFlag[] {
  return process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'];
}

// Resolve the connection URL for a given env key. Missing/empty → throw
// at boot (4-DB architecture requires all 4 URLs to be set).
function resolveDbUrl(envKey: string): string {
  const v = process.env[envKey];
  if (!v) {
    throw new Error(
      `[DB] Missing ${envKey}. Set it in .env (Layerbase pooler URL, port 5432, sslmode=require).`,
    );
  }
  return withPoolLimits(v);
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

const userUrl = resolveDbUrl('DATABASE_URL_USER');
const conversationUrl = resolveDbUrl('DATABASE_URL_CONVERSATION');
const knowledgeUrl = resolveDbUrl('DATABASE_URL_KNOWLEDGE');
const overflowUrl = resolveDbUrl('DATABASE_URL_OVERFLOW');

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

let keepAliveTimer: NodeJS.Timeout | null = null;

export function startKeepAlive(intervalMs = 60_000): void {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
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
  }, intervalMs);
  // Don't hold the process open on shutdown.
  keepAliveTimer.unref?.();
  console.log(`[DB] keep-alive armed (${Math.round(intervalMs / 1000)}s cadence, 4 datasources)`);
}

export function stopKeepAlive(): void {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
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
