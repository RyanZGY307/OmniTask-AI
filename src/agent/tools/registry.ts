// 工具注册表（tool-contracts §7.2 十二要素的代码落地）
// 治理：draft→validated→enabled→disabled→deprecated；参数校验（迷你 JSON Schema 子集：type/required/enum/max）。
// v1 注册源=本仓库内置（宿主 MCP 子集注入为后续项，见 extension-contracts §3.3）。
import { normalizePath, isInsideWorkspace } from '../policy/risk';

export interface ToolSpec {
  id: string;                       // versioned: `${name}@${semver}`
  semver: string;
  description: string;              // 模型侧工具描述（注入 prompt 用）
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  handler: string;                  // 执行器引用（模块:函数）
  dependencies?: string[];
  riskLevel: 'r0' | 'r1' | 'r2' | 'r3';
  capabilityTags?: string[];
  timeoutMs: number;
  outputBudgetTokens: number;
  cancellation: 'abort' | 'graceful' | 'non_interruptible';
  sideEffects: 'none' | 'idempotent' | 'non_idempotent' | 'external';
  idempotencyKeyFrom?: string;      // 幂等键模板（stepId:toolCallId 之外定制）
  errors: string[];
  audit: { logArgs: boolean; logResult: boolean; redactFields: string[] };
  status: 'draft' | 'validated' | 'enabled' | 'disabled' | 'deprecated';
  workspaceRoots?: string[];        // 运行时注入（路径白名单；空=拒绝一切路径操作）
}

export interface ToolResult {
  ok: boolean;
  output?: unknown;                 // Guard 前的有界输出（≤ outputBudgetTokens 估算）
  truncated?: boolean;
  errorKind?: string;               // ToolSpec.errors 之一 / 'bad_args' / 'guard_rejected' / 'timeout'
  degraded?: Array<{ kind: string; detail: string }>;
}

/** 相对路径→root 绝对化（root 为空或绝对路径原样返回） */
export function resolveArgPath(p: string, roots: string[]): string {
  if (p.startsWith('/') || roots.length === 0) return p;
  return roots[0].replace(/\/$/, '') + '/' + p;
}

export interface ToolContext {
  runId: string; stepId: string; idempotencyKey: string;
  workspaceRoots: string[];
  budget: { timeoutMs: number; outputBudgetTokens: number };
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export class ToolRegistry {
  private specs = new Map<string, ToolSpec>();
  private handlers = new Map<string, ToolHandler>();

  register(spec: ToolSpec, handler: ToolHandler): void {
    if (spec.status === 'draft') throw new Error('draft 工具不得注册到运行时（先 validated）');
    this.specs.set(spec.id, spec);
    this.handlers.set(spec.id, handler);
  }

  setStatus(id: string, status: ToolSpec['status']): void {
    const s = this.specs.get(id);
    if (s) s.status = status;
  }

  get(id: string): ToolSpec | undefined { return this.specs.get(id); }

  listEnabled(): ToolSpec[] { return [...this.specs.values()].filter((s) => s.status === 'enabled'); }

  /** 参数校验：type/required/enum/max（迷你子集；host 真实 zod 校验在宿主侧执行层） */
  validate(spec: ToolSpec, args: Record<string, unknown>): { ok: true } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    const schema = spec.inputSchema as { type?: string; required?: string[]; properties?: Record<string, { type?: string; enum?: unknown[]; max?: number }> };
    for (const key of schema.required ?? []) {
      if (args[key] === undefined) errors.push(`missing required: ${key}`);
    }
    for (const [key, val] of Object.entries(args)) {
      const p = schema.properties?.[key];
      if (!p) { errors.push(`unknown arg: ${key}`); continue; }
      if (p.type === 'string' && typeof val !== 'string') errors.push(`${key}: expect string`);
      if (p.type === 'number' && typeof val !== 'number') errors.push(`${key}: expect number`);
      if (p.type === 'boolean' && typeof val !== 'boolean') errors.push(`${key}: expect boolean`);
      if (p.enum && !p.enum.includes(val)) errors.push(`${key}: not in enum`);
      if (p.max !== undefined && typeof val === 'string' && val.length > p.max) errors.push(`${key}: > max ${p.max}`);
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  }

  /** 执行：校验→（调用方先过审批门）→handler→Guard（路径白名单/输出有界） */
  async execute(id: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const spec = this.specs.get(id);
    if (!spec) return { ok: false, errorKind: 'tool_not_found' };
    if (spec.status !== 'enabled') return { ok: false, errorKind: 'tool_disabled' };
    const v = this.validate(spec, args);
    if (!v.ok) return { ok: false, errorKind: 'bad_args' };
    if (typeof args.path === 'string') {
      const norm = normalizePath(resolveArgPath(String(args.path), ctx.workspaceRoots));
      if (!isInsideWorkspace(norm, { ...spec, workspaceRoots: ctx.workspaceRoots })) {
        return { ok: false, errorKind: 'guard_rejected' };
      }
    }
    const handler = this.handlers.get(id);
    if (!handler) return { ok: false, errorKind: 'handler_missing' };
    const r = await handler(args, { ...ctx, budget: { timeoutMs: spec.timeoutMs, outputBudgetTokens: spec.outputBudgetTokens } });
    return this.#boundOutput(spec, r);
  }

  #boundOutput(spec: ToolSpec, r: ToolResult): ToolResult {
    if (!r.ok || r.output === undefined) return r;
    const approxTokens = Math.ceil(JSON.stringify(r.output).length / 4);
    if (approxTokens > spec.outputBudgetTokens) {
      return { ...r, truncated: true, degraded: [...(r.degraded ?? []), { kind: 'output_budget', detail: `≈${approxTokens}tokens > ${spec.outputBudgetTokens}，已截断并写 artifactRef` }] };
    }
    return r;
  }
}
