// 写/执行类内置工具（M2）：write_file/edit_file/bash。
// 安全口径（docs/security/permissions-and-execution §9）：
//  - 全部经过 ToolRegistry.execute 的路径白名单 + 参数校验 + 输出预算
//  - 风险定级：write/edit=r2（可逆、可 diff 预览）；bash=r2（副作用不可逆→实际由 assessRisk 升 r3 的子命令集）
//  - bash 白名单外→guard 拒绝（不落盘尝试）；OQ-05：无沙箱执行的风险在产品文案如实披露
import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import type { ToolHandler, ToolSpec } from './registry';

function safeResolve(wsRoot: string, p: string): string | null {
  const root = resolve(wsRoot);
  const target = resolve(root, p);
  const rel = relative(root, target);
  if (rel.startsWith('..')) return null;
  return target;
}

export function writeFileSpec(ws: string[]): ToolSpec {
  return {
    id: 'write_file@1.0.0', semver: '1.0.0', description: '写入工作区内文件（幂等：覆盖写；需 r2 审批）',
    inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string', max: 1_000_000 } } },
    outputSchema: { type: 'object' }, handler: 'tools:writeFile',
    riskLevel: 'r2', timeoutMs: 10000, outputBudgetTokens: 1000, cancellation: 'graceful',
    sideEffects: 'idempotent', errors: ['guard_rejected', 'io_error'],
    audit: { logArgs: true, logResult: true, redactFields: ['content'] }, status: 'enabled', workspaceRoots: ws,
  };
}

export const writeFileHandler: ToolHandler = async (args, ctx) => {
  const root = ctx.workspaceRoots[0];
  if (!root) return { ok: false, errorKind: 'guard_rejected' };
  const target = safeResolve(root, String(args.path));
  if (!target) return { ok: false, errorKind: 'guard_rejected' };
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, String(args.content));
    return { ok: true, output: { path: args.path, bytes: Buffer.byteLength(String(args.content)) } };
  } catch { return { ok: false, errorKind: 'io_error' }; }
};

export function editFileSpec(ws: string[]): ToolSpec {
  return {
    id: 'edit_file@1.0.0', semver: '1.0.0', description: '对工作区内文件做 olds→news 精确替换（oldString 必须唯一命中）',
    inputSchema: { type: 'object', required: ['path', 'oldString', 'newString'], properties: { path: { type: 'string' }, oldString: { type: 'string', max: 100_000 }, newString: { type: 'string', max: 200_000 } } },
    outputSchema: { type: 'object' }, handler: 'tools:editFile',
    riskLevel: 'r2', timeoutMs: 10000, outputBudgetTokens: 1000, cancellation: 'graceful',
    sideEffects: 'idempotent', errors: ['guard_rejected', 'not_found', 'not_unique', 'no_change', 'io_error'],
    audit: { logArgs: true, logResult: true, redactFields: ['newString'] }, status: 'enabled', workspaceRoots: ws,
  };
}

export const editFileHandler: ToolHandler = async (args, ctx) => {
  const root = ctx.workspaceRoots[0];
  if (!root) return { ok: false, errorKind: 'guard_rejected' };
  const target = safeResolve(root, String(args.path));
  if (!target) return { ok: false, errorKind: 'guard_rejected' };
  try { statSync(target); } catch { return { ok: false, errorKind: 'not_found' }; }
  const before = readFileSync(target, 'utf8');
  const olds = String(args.oldString);
  const occurrences = before.split(olds).length - 1;
  if (occurrences === 0) return { ok: false, errorKind: 'no_change' };
  if (occurrences > 1) return { ok: false, errorKind: 'not_unique' };
  const after = before.replace(olds, String(args.newString));
  try {
    writeFileSync(target, after);
    return { ok: true, output: { path: args.path, beforeBytes: before.length, afterBytes: after.length, replaced: 1 } };
  } catch { return { ok: false, errorKind: 'io_error' }; }
};

// —— bash：M2 白名单内命令在宿主 Node 进程内受控执行（无沙箱=如实披露风险，OQ-05）——
// 注意：本环境无 /bin/sh（Termux 沙箱实测 ENOENT），故采用**无 shell 的 argv 直执行**：
//   - 拒绝一切 shell 元字符（| & ; < > $ ` 引号换行）→ 无注入面、无管道链
//   - argv 按空白切分；白名单按首 token 或前两 token（git status）
const BASH_ALLOWLIST = ['ls', 'cat', 'echo', 'pwd', 'node', 'grep', 'wc', 'find', 'head', 'tail', 'git status', 'git diff'];
const SHELL_META = /[|&;<>$`\\\n'"\\]/;

export function bashSpec(ws: string[]): ToolSpec {
  return {
    id: 'bash@1.0.0', semver: '1.0.0', description: '执行白名单内命令（受审批；无沙箱，不可逆命令需 r3→绝不自动）',
    inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string', max: 500 }, cwd: { type: 'string' } } },
    outputSchema: { type: 'object' }, handler: 'tools:bash',
    riskLevel: 'r2', timeoutMs: 15000, outputBudgetTokens: 4000, cancellation: 'abort',
    sideEffects: 'non_idempotent', errors: ['guard_rejected', 'denied_command', 'timeout', 'nonzero_exit'],
    audit: { logArgs: true, logResult: true, redactFields: [] }, status: 'enabled', workspaceRoots: ws,
  };
}

export function isBashAllowed(command: string): boolean {
  const c = command.trim();
  if (SHELL_META.test(c)) return false;   // 含 shell 元字符一律拒绝（无 shell 执行，不接受组合语法）
  const parts = c.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  const two = parts.slice(0, 2).join(' ');
  return BASH_ALLOWLIST.includes(parts[0]) || BASH_ALLOWLIST.includes(two);
}

export const bashHandler: ToolHandler = async (args, ctx) => {
  const cmd = String(args.command).trim();
  if (!isBashAllowed(cmd)) return { ok: false, errorKind: 'denied_command' };
  const root = ctx.workspaceRoots[0];
  if (!root) return { ok: false, errorKind: 'guard_rejected' };
  // 白名单命令集合已剔除非可逆/外发类药物（rm/curl/mv 等不在内）；OQ-05：沙箱缺失披露
  const { spawnSync } = await import('node:child_process');
  const t0 = Date.now();
  const parts = cmd.split(/\s+/).filter(Boolean);
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(parts[0], parts.slice(1), { cwd: resolve(root, String(args.cwd ?? '.')), timeout: ctx.budget.timeoutMs, encoding: 'utf8', maxBuffer: 1 << 20 });
  } catch {
    return { ok: false, errorKind: 'io_error' };
  }
  if (r.error) {
    const msg = r.error.message ?? '';
    if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) return { ok: false, errorKind: 'timeout' };
    if (msg.includes('ENOENT')) return { ok: false, errorKind: 'denied_command' };   // 可执行文件不在本环境
    return { ok: false, errorKind: 'io_error' };
  }
  if (r.status !== 0) return { ok: false, errorKind: 'nonzero_exit', output: { status: r.status, stderr: (r.stderr ?? '').slice(0, 2000) } };
  return { ok: true, output: { stdout: (r.stdout ?? '').slice(0, 8000), status: 0, durationMs: Date.now() - t0 } };
};

export function registerWriteTools(reg: { register: (s: ToolSpec, h: ToolHandler) => void }, ws: string[]): void {
  reg.register(writeFileSpec(ws), writeFileHandler);
  reg.register(editFileSpec(ws), editFileHandler);
  reg.register(bashSpec(ws), bashHandler);
}

export { existsSync };
