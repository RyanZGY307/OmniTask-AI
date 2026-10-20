// ================================================================
// MCP (Model Context Protocol) client — JSON-RPC 2.0 over HTTP
//
// 这是 P2 新增的**协议适配层**，不是对 connectors/mcp.ts 的扩展。
// 审计结论（决定理由见 mcp.ts 顶部注释）：
//   现有 mcp.ts 用 `GET /mcp/tools/list`、`POST /mcp/tools/{name}/call`
//   这类自定义 REST 路径去猜。真实 MCP 是 JSON-RPC 2.0：单一 endpoint，
//   方法名 initialize / tools/list / tools/call，需做 protocolVersion
//   与 capabilities 协商。两者协议族不同，没有可安全共享的结构，
//   强行"扩展"只会得到一个仍然不兼容的半成品。
//
// 因此这里独立实现，并保持旧 REST 方言可用（mcp.ts 不变），
// 由连接层按握手结果分流：真 MCP → 本适配层；REST 方言 → 旧路径。
//
// 协议依据说明（如实声明）：
//   本次开发环境的 web_fetch 后端返回 HTTP 401（api key 无效），
//   无法在线拉取 modelcontextprotocol.io 的规范原文核对最新 draft。
//   下面实现的 JSON-RPC 2.0 envelope（jsonrpc:"2.0" / id / method /
//   params / result|error）与 MCP 的 initialize、tools/list、tools/call
//   方法名、initializeResult.capabilities/serverInfo 结构，来自我对该协议
//   的既有知识，并在握手处做了保守协商（服务端返回不认识的 protocolVersion
//   时不报错，而是回退到服务端给出的版本）。若需与某具体供应商对齐，
//   应先核对官方规范；任何"已按官方规范验证"的说法都是不实的。
//
// 关键安全约束（任务书）：
//   - 协议不兼容必须是明确状态，不得伪装成"发现成功但零工具"
//   - 调用超时后无法确认外部副作用，返回 unknown 而非 failure
//   - 不在此层做权限判断，授权由 permissionEngine 负责
// ================================================================

import { R } from '../../contract';
import type { ConnectorResult } from '../../contract';
import { healthy, unhealthy, healthUnknown } from '../../contract';
import type { HealthResult } from '../../contract';
import { discovered, discoveryFailed } from '../../contract';
import type { DiscoveryResult, DiscoveredToolRef } from '../../contract';

/** JSON-RPC 2.0 envelope */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown> | unknown;
  error?: JsonRpcError;
}

export interface MCPServerInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  /** 服务端实际接受的 protocolVersion（可能与我们提议的不同） */
  negotiatedProtocolVersion?: string;
}

export interface MCPTransportOptions {
  /** MCP endpoint（JSON-RPC 2.0 over HTTP 的单一入口） */
  endpoint: string;
  /** 自定义请求头（如 API key / bearer，保存在加密凭据里） */
  headers?: Record<string, string>;
  /** 单次请求超时；默认 30s */
  timeoutMs?: number;
}

/** JSON-RPC 2.0 标准错误码（规范定义，非自定义） */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** -32000..-32099 为服务端预留实现自定义错误区间 */
  SERVER_ERROR_MIN: -32099,
  SERVER_ERROR_MAX: -32000,
} as const;

/**
 * 把 JSON-RPC 错误码映射到我们的契约状态。
 * 关键区分：METHOD_NOT_FOUND 与 PARSE_ERROR 说明这不是 MCP 服务
 * （或版本不兼容），必须归为 protocol_incompatible，让上层可以明确告知用户
 * "这不是受支持的 MCP server"，而不是含糊地报一次调用失败。
 */
export function jsonRpcToConnectorResult(err: JsonRpcError, toolId?: string): ConnectorResult {
  const label = toolId ? `MCP tool ${toolId}` : 'MCP request';
  const detail = `${label}: JSON-RPC ${err.code} ${err.message}`;
  switch (err.code) {
    case JSON_RPC_ERRORS.METHOD_NOT_FOUND:
      return R.unavailable(`服务端未实现该方法（协议不兼容）：${err.message}`, { jsonRpcCode: err.code });
    case JSON_RPC_ERRORS.INVALID_PARAMS:
      return R.fail(`参数不符合工具 schema：${err.message}`, { jsonRpcCode: err.code });
    case JSON_RPC_ERRORS.PARSE_ERROR:
    case JSON_RPC_ERRORS.INVALID_REQUEST:
      return R.unavailable(`协议层错误：${err.message}`, { jsonRpcCode: err.code });
    case JSON_RPC_ERRORS.INTERNAL_ERROR:
      // 服务端内部错误：可能已产生副作用也可能没有 → 归 unknown，重试需谨慎
      return R.unknown(detail, { jsonRpcCode: err.code });
    default:
      if (err.code >= JSON_RPC_ERRORS.SERVER_ERROR_MIN && err.code <= JSON_RPC_ERRORS.SERVER_ERROR_MAX) {
        return R.fail(detail, { jsonRpcCode: err.code });
      }
      return R.fail(detail, { jsonRpcCode: err.code });
  }
}

/** 发起一次 JSON-RPC 调用。网络/协议错误与业务错误分开处理。 */
async function rpc(
  opts: MCPTransportOptions,
  method: string,
  params?: Record<string, unknown>,
): Promise<
  | { ok: true; value: JsonRpcResponse['result'] }
  | { ok: false; transport: string; cause?: unknown; protocolIncompatible?: boolean }
  | { ok: false; rpcError: JsonRpcError }
> {
  let res: Response;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  try {
    res = await fetch(opts.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(opts.headers || {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } satisfies JsonRpcRequest),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    return { ok: false, transport: err?.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : String(err?.message || err), cause: err };
  }

  if (!res.ok) {
    return { ok: false, transport: `HTTP ${res.status} ${res.statusText || ''}`.trim() };
  }

  // 规范允许服务端以 SSE 返回；这里只接受普通 JSON 响应。
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    let text = '';
    try { text = (await res.text()).slice(0, 120); } catch { /* ignore */ }
    // P2-fix-1: 能连上但不返回 JSON-RPC 的端点（HTML 页面、空 body）是协议
    // 不兼容，不是连接失败 —— 二者对上层含义完全不同。
    return { ok: false, protocolIncompatible: true,
      transport: `unexpected content-type "${contentType || 'none'}"${text ? `: ${text}` : ''}` };
  }

  let payload: JsonRpcResponse;
  try {
    payload = await res.json() as JsonRpcResponse;
  } catch {
    return { ok: false, transport: 'response was not valid JSON' };
  }

  if (!payload || payload.jsonrpc !== '2.0') {
    return { ok: false, transport: 'response is not a JSON-RPC 2.0 envelope' };
  }
  if (payload.error) return { ok: false, rpcError: payload.error };
  if (!('result' in payload)) return { ok: false, transport: 'response has neither result nor error' };
  return { ok: true, value: payload.result };
}

/**
 * MCP 握手：initialize。
 * 返回的 negotiatedProtocolVersion 以服务端为准 —— 它可能不接受我们提议的
 * 版本并给出自己的版本。若返回的结构不像 MCP initializeResult，即视为
 * 协议不兼容（明确状态），不能退化回"发现成功但零工具"。
 */
export type MCPInitResult =
  | { kind: 'ok'; serverInfo: MCPServerInfo }
  | { kind: 'error'; status: 'protocol_incompatible' | 'connection_failed' | 'timeout' | 'auth_failed'; detail: string };

export async function mcpInitialize(opts: MCPTransportOptions): Promise<MCPInitResult> {
  const PROPOSED = '2024-11-05'; // 保守选择一个较早期的稳定版本标识
  const out = await rpc(opts, 'initialize', {
    protocolVersion: PROPOSED,
    capabilities: {},        // 客户端能力；只读工具发现与调用
    clientInfo: { name: 'omnitask-connector', version: '1.0.0' },
  });

  if (out.ok === false) {
    if ('rpcError' in out) {
      const code = out.rpcError.code;
      // -32601 method not found / -32700 parse→ 协议不兼容
      if (code === JSON_RPC_ERRORS.METHOD_NOT_FOUND || code === JSON_RPC_ERRORS.PARSE_ERROR) {
        return { kind: 'error', status: 'protocol_incompatible', detail: `initialize 调用失败（JSON-RPC ${code}），服务端可能不是 MCP server` };
      }
      return { kind: 'error', status: 'auth_failed', detail: out.rpcError.message };
    }
    // P2-fix-3: 能连上但不说 JSON-RPC 的端点是协议不兼容，不是连接失败。
    // 若缺这一分支，"这不是 MCP server"会被误报成网络问题，用户无法据此
    // 判断该换 URL 还是该重试。
    if (out.protocolIncompatible) return { kind: 'error', status: 'protocol_incompatible', detail: out.transport };
    if (/timeout/i.test(out.transport)) return { kind: 'error', status: 'timeout', detail: out.transport };
    if (/\bHTTP 401|403\b/.test(out.transport)) return { kind: 'error', status: 'auth_failed', detail: out.transport };
    return { kind: 'error', status: 'connection_failed', detail: out.transport };
  }

  const result = (out.value || {}) as any;
  // MCP initializeResult 至少带 serverInfo 与 capabilities
  if (!result || typeof result !== 'object' || !result.serverInfo || typeof result.serverInfo !== 'object') {
    return { kind: 'error', status: 'protocol_incompatible', detail: 'initialize 的 result 缺少 serverInfo，不是 MCP initializeResult' };
  }

  const negotiatedProtocolVersion = typeof result.protocolVersion === 'string'
    ? result.protocolVersion
    : PROPOSED;

  return {
    kind: 'ok',
    serverInfo: {
      name: result.serverInfo?.name,
      version: result.serverInfo?.version,
      // 两者都填：protocolVersion 是服务端声明的版本，
      // negotiatedProtocolVersion 是本任务实际协商得到的版本（当前实现中
      // 二者相同，但保留两个字段是为了将来做版本回退时不破坏既有调用方）。
      // 旧版只填了 protocolVersion，导致读 negotiatedProtocolVersion 的
      // 调用方（含 mcp.ts 的后续请求头）永远拿到 undefined。
      protocolVersion: negotiatedProtocolVersion,
      negotiatedProtocolVersion,
      capabilities: result.capabilities && typeof result.capabilities === 'object' ? result.capabilities : {},
    },
  };
}

/**
 * 工具发现：tools/list。
 * 必须能区分四种结局：成功发现 N 个、成功但零个、协议不兼容、连接/授权失败。
 */
export async function mcpListTools(opts: MCPTransportOptions): Promise<DiscoveryResult> {
  const out = await rpc(opts, 'tools/list', {});
  if (out.ok === false) {
    if ('rpcError' in out) {
      const code = out.rpcError.code;
      if (code === JSON_RPC_ERRORS.METHOD_NOT_FOUND) {
        // 服务端握手成功但不支持工具列表 —— 是合法的 MCP server，只是没有工具
        return discoveryFailed('not_configured', `服务端不支持 tools/list（JSON-RPC ${code} ${out.rpcError.message}）`);
      }
      if (code === JSON_RPC_ERRORS.PARSE_ERROR || code === JSON_RPC_ERRORS.INVALID_REQUEST) {
        return discoveryFailed('protocol_incompatible', out.rpcError.message);
      }
      return discoveryFailed('unsupported', out.rpcError.message);
    }
    if (out.protocolIncompatible) return discoveryFailed('protocol_incompatible', out.transport);
    if (/timeout/i.test(out.transport)) return discoveryFailed('timeout', out.transport);
    if (/\bHTTP 401|403\b/.test(out.transport)) return discoveryFailed('auth_failed', out.transport);
    return discoveryFailed('connection_failed', out.transport);
  }

  const result = (out.value || {}) as any;
  const rawTools: any[] = Array.isArray(result?.tools) ? result.tools : [];
  const tools: DiscoveredToolRef[] = rawTools
    .filter((t) => t && typeof t.name === 'string' && t.name.length > 0)
    .map((t) => ({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : undefined,
      inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : undefined,
      annotations: t.annotations && typeof t.annotations === 'object' ? t.annotations : undefined,
    }));

  return discovered(tools);
}

/**
 * 工具调用：tools/call。
 * MCP 规定 tool result 形如 { content: [{type:'text',text}...], isError?: boolean }。
 * 超时是重点：我们无法确认外部是否已产生副作用，因此必须返回 unknown，
 * 让上层决定重试还是人工介入，绝不能当明确失败处理。
 */
export async function mcpCallTool(
  opts: MCPTransportOptions,
  toolId: string,
  args: Record<string, unknown>,
): Promise<ConnectorResult> {
  const out = await rpc(opts, 'tools/call', { name: toolId, arguments: args || {} });
  if (out.ok === false) {
    if ('rpcError' in out) return jsonRpcToConnectorResult(out.rpcError, toolId);
    if (out.protocolIncompatible) {
      return R.unavailable(`${toolId} 调用遭遇协议不兼容：${out.transport}`);
    }
    if (/timeout/i.test(out.transport)) {
      // transport 里已含 "Timeout: ... after <ms>"，外层不再重复拼装
      const bare = out.transport.replace(/^Timeout:\s*/i, '').replace(/\s*after \d+ms\s*$/i, '');
      return R.timeout(`${toolId} 调用超时：${bare}`, opts.timeoutMs ?? 30_000);
    }
    if (/\bHTTP 401|403\b/.test(out.transport)) {
      return R.unavailable(`${toolId} 需要授权：${out.transport}`, { authRequired: true });
    }
    return R.fail(`${toolId} 调用失败：${out.transport}`);
  }

  const result = (out.value || {}) as any;
  // 业务层失败：MCP 用 isError 表达，这不是协议错误
  if (result?.isError === true) {
    const text = extractText(result) || 'tool reported isError without text content';
    return R.fail(`${toolId} 返回错误：${text}`, { isError: true });
  }

  // 结构化内容优先；没有 structuredContent 时回落到 content 数组
  const payload = result?.structuredContent !== undefined
    ? result.structuredContent
    : (Array.isArray(result?.content) ? result.content : result);

  // 空结果不是成功：外部可能执行了但我们拿不到可核实内容。
  // P2-fix-2: 旧版只排除了 null/undefined 与空串，漏了 **空对象/空数组** ——
  // 一个只回 { result: {} } 的服务端会被判成成功。空结构同样不可核实。
  const isEmptyPayload =
    payload === undefined || payload === null
    || (typeof payload === 'string' && payload.length === 0)
    || (typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload as object).length === 0)
    || (Array.isArray(payload) && payload.length === 0);
  if (isEmptyPayload) {
    return R.unknown(`${toolId} 返回空结果`, { raw: result });
  }
  return R.success(payload, true);
}

/** 从 MCP content 数组中提取纯文本（仅用于错误描述，不作为成功判据） */
function extractText(result: any): string {
  const arr = Array.isArray(result?.content) ? result.content : [];
  const parts = arr
    .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text as string);
  return parts.join('\n');
}

/**
 * 健康检查：走 initialize 握手，而不是探 /health 这类猜测路径。
 * 真 MCP 的活性证据就是"能完成一次合法的 JSON-RPC 握手"。
 */
export async function mcpHealthCheck(opts: MCPTransportOptions): Promise<HealthResult> {
  const start = Date.now();
  const init = await mcpInitialize({ ...opts, timeoutMs: opts.timeoutMs ?? 5000 });
  const latencyMs = Date.now() - start;
  if (init.kind === 'ok') {
    return healthy(latencyMs, opts.endpoint);
  }
  if (init.status === 'protocol_incompatible') {
    return unhealthy(`协议不兼容：${init.detail}`, opts.endpoint);
  }
  if (init.status === 'timeout') {
    // 检测本身超时；不代表服务一定不健康，但也不该报 healthy
    return healthUnknown(`握手超时：${init.detail}`);
  }
  return unhealthy(init.detail, opts.endpoint);
}
