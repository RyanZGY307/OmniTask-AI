// ================================================================
// 观测中心 — 只读采集器
// ================================================================
// 只做 SELECT，绝不写业务库结构、不执行 DDL、不改数据库状态。
// 采集结果写「观测自有表」（DbMetricSnapshot / DbStorageEntry，在 cortex_user），
// 页面读这些表 → 用户刷新页面不会触发全表扫描。
//
// 超时：每次统计查询用 Promise.race 包超时，超时记 errorCode 后跳过，
//       绝不阻塞业务请求，也绝不让慢库拖垮采集循环（串行执行）。
//
// 本机不可验证：无 PostgreSQL，$queryRawUnsafe 语法仅静态审查。
// ================================================================

import { prismaUser, prismaConversation, prismaKnowledge, prismaOverflow } from '../db';
import {
  PG_DB_SIZE_SQL, PG_SCHEMA_TABLE_COUNT_SQL, PG_STORAGE_BREAKDOWN_SQL,
  classifyTable, splitRelationSizes, redact, jsonSafe,
  type RedactResult,
} from './pgStats';

export interface ObservabilityDomain {
  domain: string;
  dbName: string;
  client: any;
}

const DEFAULT_DOMAINS: ObservabilityDomain[] = [
  { domain: 'user', dbName: 'cortex_user', client: null },
  { domain: 'conversation', dbName: 'cortex_conversation', client: null },
  { domain: 'knowledge', dbName: 'cortex_knowledge', client: null },
  { domain: 'overflow', dbName: 'cortex_overflow', client: null },
];

// 运行时绑定真实 client：services/db.ts 是 4 库硬编码导出的（core，不改），
// 这里在模块加载时取一次引用。新增第 5 个库时调用 registerDomain() 即可，
// 页面「已登记数据库数量」由本数组长度得出，不写死。
let DOMAINS: ObservabilityDomain[] = [];
export function bindDomains() {
  DOMAINS = DEFAULT_DOMAINS.map((d) => {
    const c =
      d.domain === 'user' ? prismaUser :
      d.domain === 'conversation' ? prismaConversation :
      d.domain === 'knowledge' ? prismaKnowledge :
      d.domain === 'overflow' ? prismaOverflow : null;
    return { ...d, client: c };
  });
}
/** 新增数据库登记的扩展点（不动 core/db.ts）。 */
export function registerDomain(domain: ObservabilityDomain) {
  if (!DOMAINS.find((d) => d.domain === domain.domain)) DOMAINS.push(domain);
}
export function listDomains(): ObservabilityDomain[] { return DOMAINS; }

const COLLECT_TIMEOUT_MS = parseInt(process.env.OBS_COLLECT_TIMEOUT_MS || '8000', 10);
const STORAGE_MAX_TABLES = 500;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timeout:${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 单次采集：4 个库串行执行，避免同时打满连接池。 */
export async function collectMetrics(now = new Date()): Promise<{
  captured: number; failed: number; results: { domain: string; ok: boolean; errorCode?: string; sizeBytes?: number }[];
}> {
  if (!DOMAINS.length) bindDomains();
  const results: { domain: string; ok: boolean; errorCode?: string; sizeBytes?: number }[] = [];
  let captured = 0, failed = 0;

  for (const d of DOMAINS) {
    const started = Date.now();
    try {
      if (!d.client) throw new Error('no_client');
      const [sizeRows, cntRows] = await Promise.all([
        withTimeout(d.client.$queryRawUnsafe(PG_DB_SIZE_SQL), COLLECT_TIMEOUT_MS, `${d.domain}:size`),
        withTimeout(d.client.$queryRawUnsafe(PG_SCHEMA_TABLE_COUNT_SQL), COLLECT_TIMEOUT_MS, `${d.domain}:count`),
      ]);
      const sizeBytes = Number((sizeRows as any[])[0]?.size_bytes ?? 0);
      await prismaUser.dbMetricSnapshot.create({
        data: jsonSafe({
          capturedAt: now, domain: d.domain, dbName: d.dbName,
          connectionStatus: 'available',
          sizeBytes: BigInt(Math.max(0, Math.trunc(sizeBytes))),
          schemaCount: Number((cntRows as any[])[0]?.schema_count ?? 0),
          tableCount: Number((cntRows as any[])[0]?.table_count ?? 0),
          latencyMs: Date.now() - started,
          instanceSource: 'unknown',
          instanceDiskUsedBytes: null,
          instanceDiskTotalBytes: null,
          instanceDiskAvailableBytes: null,
          createdAt: now,
        }),
      });
      // 计算 24h 增长（与同 domain 最近一个可用快照比）
      const prev = await prismaUser.dbMetricSnapshot.findFirst({
        where: { domain: d.domain, connectionStatus: 'available', sizeBytes: { not: null }, capturedAt: { lte: new Date(now.getTime() - 24 * 3600 * 1000) } },
        orderBy: { capturedAt: 'desc' }, select: { sizeBytes: true },
      });
      if (prev?.sizeBytes != null) {
        await prismaUser.dbMetricSnapshot.updateMany({
          where: { domain: d.domain, capturedAt: now },
          data: { growthBytes24h: BigInt(Math.trunc(sizeBytes) - Number(prev.sizeBytes)) },
        });
      }
      captured++;
      results.push({ domain: d.domain, ok: true, sizeBytes });
    } catch (err: any) {
      failed++;
      const code = String(err?.message || '').startsWith('timeout:') ? 'collection_timeout' : 'query_failed';
      const rr: RedactResult = redact(String(err?.message || err));
      try {
        await prismaUser.dbMetricSnapshot.create({
          data: jsonSafe({
            capturedAt: now, domain: d.domain, dbName: d.dbName,
            connectionStatus: 'unavailable', errorCode: code,
            errorMessage: undefined, latencyMs: Date.now() - started,
            instanceSource: 'unknown', createdAt: now,
          }),
        });
      } catch { /* 观测自身失败不得影响业务 */ }
      await recordCollectionEvent(d, code, rr.applied, now);
      results.push({ domain: d.domain, ok: false, errorCode: code });
    }
  }
  return { captured, failed, results };
}

/** 表/索引/TOAST 明细采集。独立于 collectMetrics，频率更低。 */
export async function collectStorageBreakdown(now = new Date()): Promise<{ captured: number; failed: number }> {
  if (!DOMAINS.length) bindDomains();
  let captured = 0, failed = 0;
  for (const d of DOMAINS) {
    try {
      if (!d.client) continue;
      const rows = await withTimeout(
        d.client.$queryRawUnsafe(PG_STORAGE_BREAKDOWN_SQL), COLLECT_TIMEOUT_MS, `${d.domain}:storage`,
      ) as any[];
      const captureId = `cap_${d.domain}_${now.getTime().toString(36)}`;
      for (const r of rows) {
        const { tableBytes, indexBytes, toastBytes } = splitRelationSizes(
          Number(r.toast_bytes ?? 0) + Number(r.table_bytes ?? 0) + Number(r.index_bytes ?? 0),
          Number(r.table_bytes ?? 0), Number(r.index_bytes ?? 0),
        );
        const cat = classifyTable(String(r.schema_name), String(r.table_name));
        const rr: RedactResult = redact(cat.evidence);
        const entries: any[] = [
          { schemaName: r.schema_name, tableName: r.table_name, objectKind: 'table', sizeBytes: tableBytes },
          { schemaName: r.schema_name, tableName: r.table_name, objectKind: 'index', sizeBytes: indexBytes },
          { schemaName: r.schema_name, tableName: r.table_name, objectKind: 'toast', sizeBytes: toastBytes },
        ];
        for (const e of entries) {
          if (e.sizeBytes <= 0) continue;
          await prismaUser.dbStorageEntry.create({
            data: jsonSafe({
              captureId, capturedAt: now, domain: d.domain, dbName: d.dbName,
              schemaName: String(e.schemaName), tableName: String(e.tableName),
              objectKind: e.objectKind, sizeBytes: BigInt(Math.trunc(e.sizeBytes)),
              rowEstimate: r.row_estimate == null ? null : BigInt(Math.trunc(Number(r.row_estimate))),
              businessCategory: cat.category, categoryConfidence: cat.confidence,
              categoryEvidence: rr.text, createdAt: now,
            }),
          });
        }
      }
      // 只保留最近 N 个 captureId，防止明细无限增长
      const old = await prismaUser.dbStorageEntry.findMany({
        where: { domain: d.domain }, orderBy: { capturedAt: 'desc' },
        skip: STORAGE_MAX_TABLES, select: { id: true }, take: 2000,
      });
      if (old.length) {
        await prismaUser.dbStorageEntry.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
      }
      captured++;
    } catch { failed++; }
  }
  return { captured, failed };
}

async function recordCollectionEvent(d: ObservabilityDomain, code: string, applied: string[], now: Date) {
  try {
    await prismaUser.obsEvent.create({
      data: jsonSafe({
        ts: now, kind: code === 'collection_timeout' ? 'collection_timeout' : 'db_connect_fail',
        severity: code === 'collection_timeout' ? 'warning' : 'critical',
        title: `数据库采集失败：${d.dbName}`,
        detail: `错误类型 ${code}（已脱敏${applied.length ? `：${applied.join(',')}` : ''}）`,
        domain: d.domain, status: 'open', resolved: false, createdAt: now,
      }),
    });
  } catch { /* 事件写入失败不影响主流程 */ }
}

/** 采集失败时同时落一条「容量不可获取」提示，避免页面把缺失当 0。 */
export async function recordCapacityUnknown(now = new Date(), note = '托管平台未提供实例磁盘容量指标') {
  try {
    await prismaUser.obsEvent.create({
      data: jsonSafe({
        ts: now, kind: 'capacity_unknown', severity: 'info',
        title: '实例磁盘容量不可获取',
        detail: redact(note).text,
        domain: null, status: 'open', resolved: false, createdAt: now,
      }),
    });
  } catch { /* noop */ }
}
