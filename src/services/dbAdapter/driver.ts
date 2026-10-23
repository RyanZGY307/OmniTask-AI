// ================================================================
// DB 连接适配层 — 驱动加载与统一查询接口
// ================================================================
// 设计约束（环境现实决定）：
//   · 部署目标 Render = Linux x64 / Node 20 → better-sqlite3 与
//     @libsql/client 的平台列表均含 linux+x64，**可安装**。
//   · 本开发机是 Android arm64，两者平台列表都不含 android，**装不上**。
//   · Node 20 没有内置 node:sqlite（需 ≥22.5）。
//
// 因此本文件用「运行时动态 require + 能力探测」：
//   · 驱动存在 → 正常用；
//   · 驱动缺失（本机）→ 返回明确 unavailable 原因，**绝不静默失败**，
//     调用方据此走 PostgreSQL 或报「暂未接入」，不假装 SQLite 在跑。
//
// 绝不 import 具体驱动的类型（本机没有 → TS 编译不过），统一用 any。
// ================================================================

import { parseConnection, requiresApiKey, type ConnectionSpec } from './spec';

export interface DriverProbe {
  engine: 'postgres' | 'sqlite' | 'libsql';
  available: boolean;
  reason: string;
  detail: string;
}

/** 探测 SQLite 原生驱动是否可用。 */
export function probeSqliteDriver(): DriverProbe {
  const candidates = ['better-sqlite3', 'node:sqlite'];
  const tried: string[] = [];
  for (const name of candidates) {
    tried.push(name);
    try {
      const mod = name === 'node:sqlite' ? require('node:sqlite') : require(name);
      if (mod?.DatabaseSync || mod?.Database) {
        return {
          engine: 'sqlite', available: true,
          reason: `驱动可用：${name}`,
          detail: name === 'node:sqlite' ? 'Node 内置（需 Node ≥22.5）' : 'better-sqlite3 原生绑定',
        };
      }
    } catch (e: any) {
      if (e?.code === 'MODULE_NOT_FOUND') continue;
      // 平台不匹配（EBADPLATFORM 之类）也要如实报，不吞
      return { engine: 'sqlite', available: false, reason: `驱动加载失败：${name} ${e?.code || e?.message || ''}`.trim(), detail: tried.join(', ') };
    }
  }
  return {
    engine: 'sqlite', available: false,
    reason: '未安装 SQLite 驱动：better-sqlite3（部署目标 linux/x64 可装）/ node:sqlite（需 Node ≥22.5）',
    detail: tried.join(', '),
  };
}

export function probeLibsqlDriver(): DriverProbe {
  try {
    const mod = require('@libsql/client');
    if (mod?.createClient) return { engine: 'libsql', available: true, reason: '驱动可用：@libsql/client', detail: 'libSQL / Turso SDK' };
  } catch (e: any) {
    if (e?.code !== 'MODULE_NOT_FOUND') {
      return { engine: 'libsql', available: false, reason: `驱动加载失败：${e?.code || e?.message || ''}`, detail: '@libsql/client' };
    }
  }
  return { engine: 'libsql', available: false, reason: '未安装 @libsql/client', detail: '' };
}

/** PostgreSQL 走既有 Prisma client，始终可用（与 services/db.ts 同源）。 */
export function probePostgresDriver(): DriverProbe {
  return { engine: 'postgres', available: true, reason: 'Prisma Client（既有）', detail: '@prisma/client-*' };
}

/**
 * 按连接规格选驱动。返回的 handle 暴露最小只读/受控写入接口，
 * **不暴露任意 SQL 执行**给上层业务（上层只调语义化方法）。
 */
export interface DbHandle {
  engine: string;
  driver: string;
  /** 只读便捷查询（驱动方言由本层转换） */
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  /** 受控写入（调用方必须已通过安全门禁） */
  execute(sql: string, params?: any[]): Promise<{ changes: number }>;
  /** 事务（SQLite 同步，PostgreSQL 异步；统一为 Promise） */
  transaction<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  probe: DriverProbe;
}

export interface TxHandle {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  execute(sql: string, params?: any[]): Promise<{ changes: number }>;
}

class SqliteHandle implements DbHandle {
  constructor(private db: any, readonly probe: DriverProbe) {}
  get engine() { return 'sqlite'; }
  get driver() { return this.probe.reason; }
  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const rows = params?.length ? stmt.all(...params) : stmt.all();
    return rows as T[];
  }
  async execute(sql: string, params: any[] = []): Promise<{ changes: number }> {
    const stmt = this.db.prepare(sql);
    const r = params?.length ? stmt.run(...params) : stmt.run();
    return { changes: Number(r?.changes ?? 0) };
  }
  async transaction<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T> {
    const tx: TxHandle = {
      query: async <X = any>(sql: string, params: any[] = []) => this.query<X>(sql, params),
      execute: async (sql: string, params: any[] = []) => this.execute(sql, params),
    };
    this.db.exec('BEGIN');
    try {
      const out = await fn(tx);
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* noop */ }
      throw e;
    }
  }
  async close() { try { this.db.close(); } catch { /* noop */ } }
}

class LibsqlHandle implements DbHandle {
  constructor(private client: any, readonly probe: DriverProbe) {}
  get engine() { return 'libsql'; }
  get driver() { return this.probe.reason; }
  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const r = await this.client.execute(sql, params ?? []);
    return (r?.rows ?? []) as T[];
  }
  async execute(sql: string, params: any[] = []): Promise<{ changes: number }> {
    const r = await this.client.execute(sql, params ?? []);
    return { changes: Number(r?.rowsAffected ?? 0) };
  }
  async transaction<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T> {
    const tx: TxHandle = {
      query: async <X = any>(sql: string, params: any[] = []) => this.query<X>(sql, params),
      execute: async (sql: string, params: any[] = []) => this.execute(sql, params),
    };
    await this.client.batch([{ sql: 'BEGIN' }]).catch(() => { /* libsql 支持 implicit */ });
    try {
      const out = await fn(tx);
      await this.client.batch([{ sql: 'COMMIT' }]).catch(() => { /* noop */ });
      return out;
    } catch (e) {
      await this.client.batch([{ sql: 'ROLLBACK' }]).catch(() => { /* noop */ });
      throw e;
    }
  }
  async close() { try { this.client.close?.(); } catch { /* noop */ } }
}

/**
 * 打开一个连接。三类失败都如实返回 { ok:false, reason }：
 *   驱动缺失 / 规格解析失败 / 缺少 API key。
 * **绝不静默回退到别的引擎**——那会让页面显示错的数据库。
 */
export async function openConnection(input: unknown): Promise<
  { ok: true; handle: DbHandle; spec: ConnectionSpec } | { ok: false; reason: string; spec: ConnectionSpec | null }
> {
  const spec = parseConnection(input);
  if (spec.error) return { ok: false, reason: spec.error, spec };
  if (requiresApiKey(spec)) return { ok: false, reason: '需要 API key 但未提供', spec };

  if (spec.engine === 'postgres') {
    // PostgreSQL 由既有 Prisma 层承担，本适配器只登记规格，
    // 具体查询仍走 services/db.ts 的 client（避免第二套连接池）。
    return { ok: true, handle: postgresProbeHandle(spec), spec };
  }

  if (spec.engine === 'sqlite') {
    const probe = probeSqliteDriver();
    if (!probe.available) {
      return { ok: false, reason: `SQLite 暂未接入：${probe.reason}`, spec };
    }
    try {
      const mod = probe.reason.includes('node:sqlite')
        ? require('node:sqlite')
        : require('better-sqlite3');
      const Ctor = mod.DatabaseSync ?? mod.Database;
      const db = new Ctor(spec.filePath === ':memory:' ? ':memory:' : spec.filePath);
      db.exec?.('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      return { ok: true, handle: new SqliteHandle(db, probe), spec };
    } catch (e: any) {
      return { ok: false, reason: `SQLite 打开失败：${e?.message || e}`, spec };
    }
  }

  if (spec.engine === 'libsql') {
    const probe = probeLibsqlDriver();
    if (!probe.available) return { ok: false, reason: `libSQL 暂未接入：${probe.reason}`, spec };
    try {
      const { createClient } = require('@libsql/client');
      const url = spec.normalized.split('?')[0];
      const client = createClient({ url, authToken: spec.apiKey ?? undefined });
      return { ok: true, handle: new LibsqlHandle(client, probe), spec };
    } catch (e: any) {
      return { ok: false, reason: `libSQL 连接失败：${e?.message || e}`, spec };
    }
  }

  return { ok: false, reason: `暂不支持的引擎：${spec.engine}`, spec };
}

/**
 * PostgreSQL 句柄：把规格包装成 DbHandle 形状，但**查询转发给 Prisma 层**。
 * 这里只暴露能力描述，真实 SQL 由调用方用 Prisma client 执行 ——
 * 目的是让「适配层」与「既有 Prisma 层」不产生第二套连接池。
 */
function postgresProbeHandle(spec: ConnectionSpec): DbHandle {
  return {
    engine: 'postgres',
    driver: 'Prisma（既有，由 services/db.ts 持有连接池）',
    probe: probePostgresDriver(),
    query: async () => { throw new Error('PostgreSQL 查询必须经由 Prisma client（services/db.ts），适配层不复制连接池'); },
    execute: async () => { throw new Error('PostgreSQL 写入必须经由 Prisma client（services/db.ts）'); },
    transaction: async () => { throw new Error('PostgreSQL 事务必须经由 Prisma $transaction'); },
    close: async () => { /* Prisma 生命周期由 db.ts 管理 */ },
  };
}

/** 供 admin 页展示「当前能力矩阵」，不暴露任何凭据。 */
export function capabilityMatrix() {
  return {
    postgres: probePostgresDriver(),
    sqlite: probeSqliteDriver(),
    libsql: probeLibsqlDriver(),
    note: '驱动缺失只影响本机验证；部署目标（linux/x64）支持 better-sqlite3 与 @libsql/client',
  };
}
