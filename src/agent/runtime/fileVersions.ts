// 文件版本与回滚（M3 roadmap：CheckpointMgr + 文件版本 + 回滚）。
// 语义：写/编辑工具执行**前**把旧内容存档（内容寻址 + 序号），run 内可回滚到任一版本；
//       回滚是「显式人工动作」，发 tool.replayed_skipped 同级事件留痕（不是静默覆盖）。
// 边界（诚实）：版本库存放于 workspace 内的 `.agent-versions/`；宿主侧应把它纳入 WorkspaceFile 语义/备份策略，
//       本仓库不复制宿主的持久化实现；不承诺跨机器/跨宿主迁移。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import type { ToolHandler, ToolSpec } from '../tools/registry';
import { writeFileHandler, editFileHandler, writeFileSpec, editFileSpec } from '../tools/writeTools';

export const VERSIONS_DIR = '.agent-versions';

export interface VersionRecord {
  versionId: string;          // `${runId}/${seq}`
  runId: string; stepId: string; absPath: string;
  bytes: number; sha256: string; createdAt: string;
  op: 'write_file' | 'edit_file' | 'manual';
}

export class FileVersionStore {
  private seq = 0;
  private records: VersionRecord[] = [];
  readonly root: string;

  constructor(root: string) { this.root = root; }

  private dirFor(runId: string): string {
    const d = join(this.root, runId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** 存档当前内容（文件不存在→null：新文件没有旧版可回滚） */
  save(runId: string, stepId: string, absPath: string, op: VersionRecord['op']): VersionRecord | null {
    if (!existsSync(absPath)) return null;
    const buf = readFileSync(absPath);
    const record: VersionRecord = {
      versionId: `${runId}/${++this.seq}`, runId, stepId, absPath,
      bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
      createdAt: new Date().toISOString(), op,
    };
    const dest = join(this.dirFor(runId), `${record.versionId.replace('/', '_')}${ext(absPath)}`);
    copyFileSync(absPath, dest);
    this.records.push(record);
    this.persistIndex(runId);
    return record;
  }

  /** 索引落盘（run 内所有存档的 absPath/op/sha256）；rebuildFromDisk 依赖它还原绝对路径 */
  private persistIndex(runId: string): void {
    const d = join(this.root, runId);
    const rows = this.records.filter((r) => r.runId === runId)
      .map((r) => ({ versionId: r.versionId, stepId: r.stepId, absPath: r.absPath, op: r.op, sha256: r.sha256, bytes: r.bytes, createdAt: r.createdAt }));
    try { writeFileSync(join(d, 'index.json'), JSON.stringify(rows, null, 1)); } catch { /* 索引失败不影响本次存档（rollback 仍可用内存索引） */ }
  }

  list(runId?: string): VersionRecord[] {
    return runId ? this.records.filter((r) => r.runId === runId) : [...this.records];
  }

  get(versionId: string): VersionRecord | undefined { return this.records.find((r) => r.versionId === versionId); }

  /** 回滚：把存档内容写回原路径（幂等——同版本重复回滚结果一致） */
  rollback(versionId: string): { ok: true; restored: string; reason?: string } | { ok: false; reason: 'version_not_found' | 'archive_missing' | 'io_error' | 'path_unresolved' } {
    const rec = this.get(versionId);
    if (!rec) return { ok: false, reason: 'version_not_found' };
    // 诚实边界：从盘上重建且索引缺失的记录 absPath 未解析——不得往推测路径写（旧实现会写出字面名为 '(unresolved)' 的文件）
    if (rec.absPath === '(unresolved)') return { ok: false, reason: 'path_unresolved' };
    const src = join(this.root, rec.runId, `${versionId.replace('/', '_')}${ext(rec.absPath)}`);
    if (!existsSync(src)) return { ok: false, reason: 'archive_missing' };
    try {
      mkdirSync(dirname(rec.absPath), { recursive: true });
      writeFileSync(rec.absPath, readFileSync(src));
      return { ok: true, restored: rec.absPath };
    } catch { return { ok: false, reason: 'io_error' }; }
  }

  /** 清理某 Run 的存档（用户显式要求时才可调用；默认保留） */
  purge(runId: string): { removed: number } {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.runId !== runId);
    const d = join(this.root, runId);
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    return { removed: before - this.records.length };
  }

  /** 兜底：进程重启后从盘上重建索引（versionId 从文件名反解，absPath 从 index.json 解析） */
  rebuildFromDisk(): VersionRecord[] {
    if (!existsSync(this.root)) return [];
    const out: VersionRecord[] = [];
    for (const runDir of readdirSync(this.root, { withFileTypes: true })) {
      if (!runDir.isDirectory()) continue;
      const idxPath = join(this.root, runDir.name, 'index.json');
      const idx = new Map<string, { absPath: string; stepId: string; op: VersionRecord['op'] }>();
      if (existsSync(idxPath)) {
        try {
          for (const row of JSON.parse(readFileSync(idxPath, 'utf8')) as Array<Record<string, string>>) {
            idx.set(String(row.versionId), { absPath: String(row.absPath), stepId: String(row.stepId), op: (row.op ?? 'manual') as VersionRecord['op'] });
          }
        } catch { /* 索引损坏：降级为不可回滚记录（见下） */ }
      }
      for (const f of readdirSync(join(this.root, runDir.name))) {
        if (f === 'index.json') continue;
        const m = /^(?<run>.+)_(?<seq>\d+)(?<ext>\.[^_]+)$/.exec(f);
        if (!m || !m.groups) continue;
        const versionId = `${m.groups.run}/${m.groups.seq}`;
        if (this.records.some((r) => r.versionId === versionId)) continue;   // 已在内存（幂等重建）
        const meta = idx.get(versionId);
        const buf = readFileSync(join(this.root, runDir.name, f));
        out.push({
          versionId, runId: m.groups.run, stepId: meta?.stepId ?? 'unknown',
          absPath: meta?.absPath ?? '(unresolved)', bytes: buf.length,
          sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
          createdAt: new Date().toISOString(), op: meta?.op ?? 'manual',
        });
      }
    }
    this.seq = Math.max(0, ...out.map((r) => Number(r.versionId.split('/')[1]) || 0));
    this.records = [...this.records, ...out];
    return out;
  }
}

function ext(p: string): string {
  const i = p.lastIndexOf('.');
  return i > p.lastIndexOf('/') ? p.slice(i) : '.bin';
}

/**
 * 注册「带版本的写工具」：在执行前存档旧内容。
 * 语义保持与无包装版一致（同 spec/同 handler），仅追加版本记录与事件。
 */
export function registerVersionedWriteTools(
  reg: { register(spec: ToolSpec, handler: ToolHandler): void },
  ws: string[],
  store?: { append(runId: string, draft: Record<string, unknown>): Promise<unknown> },
  versions?: FileVersionStore,
): FileVersionStore {
  const store2 = versions ?? new FileVersionStore(join(ws[0] ?? '.', VERSIONS_DIR));

  const wrap = (op: VersionRecord['op'], inner: ToolHandler): ToolHandler => async (args, ctx) => {
    const rec = store2.save(ctx.runId, ctx.stepId, join(ws[0] ?? '.', String(args.path ?? '')), op);
    const r = await inner(args, ctx);
    if (store && rec) {
      await store.append(ctx.runId, { type: 'step.succeeded', level: 'info', payload: { stepId: ctx.stepId, kind: 'file_version', versionId: rec.versionId, absPath: rec.absPath, sha256: rec.sha256, ok: r.ok } });
    }
    return r;
  };

  reg.register(writeFileSpec(ws), wrap('write_file', writeFileHandler));
  reg.register(editFileSpec(ws), wrap('edit_file', editFileHandler));
  return store2;
}

/**
 * 一键注册「带版本的写工具 + 回滚工具」：
 * 写/编辑执行前自动存档旧内容；file_rollback@1.0.0（r3）始终注册——宿主不得只注册前者而不注册回滚，
 * 否则用户面对"被改过的文件"没有恢复手段（旧版 rollbackSpec 无处被 register，能力实际不可达）。
 */
export function registerVersionedWriteToolsWithRollback(
  reg: { register(spec: ToolSpec, handler: ToolHandler): void },
  ws: string[],
  store?: { append(runId: string, draft: Record<string, unknown>): Promise<unknown> },
  versions?: FileVersionStore,
): { versions: FileVersionStore; rollbackToolId: string } {
  const v = registerVersionedWriteTools(reg, ws, store, versions);
  reg.register(rollbackSpec(), rollbackHandler(v));
  return { versions: v, rollbackToolId: 'file_rollback@1.0.0' };
}

/** 回滚工具（r3：覆盖用户当前文件=不可逆副作用；绝不能自动执行） */
export function rollbackSpec(): ToolSpec {
  return {
    id: 'file_rollback@1.0.0', semver: '1.0.0',
    description: '把文件回滚到指定版本存档（不可逆覆盖，需 r3 人工批准）',
    inputSchema: { type: 'object', required: ['versionId'], properties: { versionId: { type: 'string' } } },
    outputSchema: { type: 'object' }, handler: 'runtime:fileRollback',
    riskLevel: 'r3', timeoutMs: 5000, outputBudgetTokens: 500, cancellation: 'graceful',
    sideEffects: 'non_idempotent', capabilityTags: ['delete_out_of_scope'],
    errors: ['version_not_found', 'archive_missing', 'io_error'],
    audit: { logArgs: true, logResult: true, redactFields: [] }, status: 'enabled',
  };
}

export function rollbackHandler(store: FileVersionStore): ToolHandler {
  return async (args) => {
    const r = store.rollback(String(args.versionId));
    return r.ok ? { ok: true, output: r } : { ok: false, errorKind: r.reason };
  };
}
