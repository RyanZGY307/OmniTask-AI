// Todo/工件进展服务（M1 遗留项落地）：字段与 prisma/schema-agent.prisma 的 Todo/Artifact 逐字对齐。
// 边界：本实现是**进程内 L1 存储**；宿主侧按同名模型落 Prisma（本仓库不复制持久化实现）。
// 与 no_progress 的关系：`lastArtifactSeq` 供 advisor 触发判定（M3 advisor.ts 的 stepsSinceArtifact）。
import type { ToolHandler, ToolSpec } from '../tools/registry';

export const TODO_STATUSES = ['pending', 'in_progress', 'blocked', 'completed'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const ARTIFACT_KINDS = ['file', 'report', 'plan', 'diff', 'other'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface Todo {
  id: string; runId: string; seq: number; title: string;
  status: TodoStatus; blockedBy?: string;
}

export interface Artifact {
  id: string; taskId: string; kind: ArtifactKind; title: string;
  uri: string; storageRef?: string; stepId?: string; version: number;
}

/** 状态迁移白名单（完成态不得静默退回 pending——审计可解释的倒流需显式 in_progress） */
export function canTransition(from: TodoStatus, to: TodoStatus): boolean {
  if (from === to) return true;
  if (to === 'completed') return true;
  if (from === 'completed') return to === 'in_progress';
  return true;
}

export class TodoService {
  private todos = new Map<string, Todo[]>();       // runId → todos
  private artifacts: Artifact[] = [];
  private seq = 0;

  add(runId: string, title: string, blockedBy?: string): Todo {
    const list = this.todos.get(runId) ?? [];
    const todo: Todo = { id: `td_${runId}_${list.length + 1}`, runId, seq: list.length + 1, title, status: 'pending', blockedBy };
    list.push(todo);
    this.todos.set(runId, list);
    return todo;
  }

  setStatus(runId: string, id: string, status: TodoStatus): { ok: true; todo: Todo; reason?: string } | { ok: false; reason: string } {
    const todo = this.todos.get(runId)?.find((t) => t.id === id);
    if (!todo) return { ok: false, reason: 'todo_not_found' };
    if (!canTransition(todo.status, status)) return { ok: false, reason: 'illegal_transition' };
    todo.status = status;
    return { ok: true, todo };
  }

  list(runId: string): Todo[] { return [...(this.todos.get(runId) ?? [])]; }

  summary(runId: string): { total: number; completed: number; pending: number; in_progress: number; blocked: number } {
    const all = this.list(runId);
    return {
      total: all.length,
      completed: all.filter((t) => t.status === 'completed').length,
      pending: all.filter((t) => t.status === 'pending').length,
      in_progress: all.filter((t) => t.status === 'in_progress').length,
      blocked: all.filter((t) => t.status === 'blocked').length,
    };
  }

  /** 工件登记：artifacts 单调递增（no_progress 判定的进展证据） */
  addArtifact(a: Omit<Artifact, 'id' | 'version'> & { version?: number }): Artifact {
    const artifact: Artifact = { ...a, id: `art_${++this.seq}`, version: a.version ?? 1 };
    this.artifacts.push(artifact);
    return artifact;
  }

  listArtifacts(taskId?: string): Artifact[] { return taskId ? this.artifacts.filter((a) => a.taskId === taskId) : [...this.artifacts]; }

  /** 最新工件序号（0=无工件）：advisor stepsSinceArtifact 的对照基线 */
  get lastArtifactSeq(): number { return this.seq; }
}

// —— 工具三件套（spec/handler 分离，形态与 tools/builtin.ts 一致）——

export function todoWriteSpec(): ToolSpec {
  return {
    id: 'todo_write@1.0.0', semver: '1.0.0',
    description: '创建或更新当前 Run 的待办（对齐 Todo 模型：seq/title/status/blockedBy）',
    inputSchema: {
      type: 'object', required: [],
      properties: {
        title: { type: 'string' }, id: { type: 'string' },
        status: { type: 'string', enum: TODO_STATUSES }, blockedBy: { type: 'string' },
      },
    },
    outputSchema: { type: 'object' },
    handler: 'runtime:todoWrite',
    riskLevel: 'r0', timeoutMs: 1000, outputBudgetTokens: 1000, cancellation: 'abort',
    sideEffects: 'idempotent', errors: ['invalid_args', 'todo_not_found', 'illegal_transition'],
    audit: { logArgs: true, logResult: true, redactFields: [] },
    status: 'enabled',
  };
}

export function todoWriteHandler(service: TodoService): ToolHandler {
  return async (args, ctx) => {
    const runId = ctx.runId;
    const id = typeof args.id === 'string' ? args.id : undefined;
    if (id) {
      const r = service.setStatus(runId, id, (args.status as TodoStatus) ?? 'in_progress');
      return r.ok ? { ok: true, output: r.todo } : { ok: false, errorKind: r.reason };
    }
    if (typeof args.title !== 'string' || !args.title) return { ok: false, errorKind: 'invalid_args' };
    return { ok: true, output: service.add(runId, args.title, typeof args.blockedBy === 'string' ? args.blockedBy : undefined) };
  };
}

export function todoReadSpec(): ToolSpec {
  return {
    id: 'todo_read@1.0.0', semver: '1.0.0',
    description: '读取当前 Run 的待办列表与完成度摘要',
    inputSchema: { type: 'object', required: [], properties: {} },
    outputSchema: { type: 'object' },
    handler: 'runtime:todoRead',
    riskLevel: 'r0', timeoutMs: 500, outputBudgetTokens: 2000, cancellation: 'abort',
    sideEffects: 'none', errors: [],
    audit: { logArgs: false, logResult: true, redactFields: [] },
    status: 'enabled',
  };
}

export function todoReadHandler(service: TodoService): ToolHandler {
  return async (_args, ctx) => ({ ok: true, output: { todos: service.list(ctx.runId), summary: service.summary(ctx.runId) } });
}

export function artifactRegisterSpec(): ToolSpec {
  return {
    id: 'artifact_register@1.0.0', semver: '1.0.0',
    description: '登记工件（file/report/plan/diff）——no_progress 与 advisor 判定的进展证据',
    inputSchema: {
      type: 'object', required: ['taskId', 'kind', 'title', 'uri'],
      properties: {
        taskId: { type: 'string' }, kind: { type: 'string', enum: ARTIFACT_KINDS },
        title: { type: 'string' }, uri: { type: 'string' },
        storageRef: { type: 'string' }, stepId: { type: 'string' },
      },
    },
    outputSchema: { type: 'object' },
    handler: 'runtime:artifactRegister',
    riskLevel: 'r1', timeoutMs: 1000, outputBudgetTokens: 1000, cancellation: 'abort',
    sideEffects: 'idempotent', errors: ['invalid_args'],
    audit: { logArgs: true, logResult: true, redactFields: [] },
    status: 'enabled',
  };
}

export function artifactRegisterHandler(service: TodoService): ToolHandler {
  return async (args, ctx) => {
    const taskId = typeof args.taskId === 'string' ? args.taskId : '';
    const kind = typeof args.kind === 'string' ? args.kind : '';
    const title = typeof args.title === 'string' ? args.title : '';
    const uri = typeof args.uri === 'string' ? args.uri : '';
    if (!taskId || !title || !uri) return { ok: false, errorKind: 'invalid_args' };
    if (!ARTIFACT_KINDS.includes(kind as ArtifactKind)) return { ok: false, errorKind: 'invalid_args' };
    const a = service.addArtifact({
      taskId, kind: kind as ArtifactKind, title, uri,
      storageRef: typeof args.storageRef === 'string' ? args.storageRef : undefined,
      stepId: typeof args.stepId === 'string' ? args.stepId : ctx.stepId,
    });
    return { ok: true, output: a };
  };
}

export function registerTodoTools(registry: { register(spec: ToolSpec, handler: ToolHandler): void }, service: TodoService): void {
  registry.register(todoWriteSpec(), todoWriteHandler(service));
  registry.register(todoReadSpec(), todoReadHandler(service));
  registry.register(artifactRegisterSpec(), artifactRegisterHandler(service));
}
