// MCP 客户端子集（M3）：通过宿主真实 JSON-RPC 2.0 客户端复用（EV-MP-006，禁止自建传输/三方 SDK）。
// 本文件定义**接入契约**：宿主 mcp client 以适配器形式注入；协议动作与宿主保持一致。
export interface McpToolDescriptor {
  name: string;                    // 工具名（宿主侧命名）
  description: string;
  inputSchema: Record<string, unknown>;
  /** 宿主侧风险提示（映射到 r0–r3 的初始猜测，最终以参数级复核为准） */
  riskHint?: 'read' | 'write' | 'exec';
}

export interface McpListResult { tools: McpToolDescriptor[]; }

export interface McpCallResult {
  ok: boolean;
  content?: unknown;
  isError?: boolean;
  errorKind?: 'not_connected' | 'tool_not_found' | 'timeout' | 'protocol_error' | 'host_denied';
}

/**
 * 宿主 MCP 适配器契约（宿主注入实现）。
 * 红线：本仓库永不自带 MCP 传输（spawn stdio / SSE）——宿主已实现，重复即分叉。
 */
export interface HostMcpAdapter {
  listTools(serverId: string): Promise<McpListResult>;
  callTool(serverId: string, name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

/** 工具名规范化：`mcp:<serverId>.<name>` → 我方 versioned id 形（与内置工具同一命名空间） */
export function toVersionedToolId(serverId: string, name: string): string {
  return `mcp:${sanitize(serverId)}.${sanitize(name)}@0.0.0-host`;
}

export function fromVersionedToolId(id: string): { serverId: string; name: string } | null {
  const m = /^mcp:([^@]+)\.([^@]+)@/.exec(id);
  if (!m) return null;
  return { serverId: unSanitize(m[1]), name: unSanitize(m[2]) };
}

function sanitize(s: string): string { return s.replace(/[^a-zA-Z0-9_-]/g, '_'); }
function unSanitize(s: string): string { return s; }
