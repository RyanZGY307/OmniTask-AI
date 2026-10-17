export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  toolName: string;
  result: string;
}

export const AVAILABLE_TOOLS = [
  { name: 'search_knowledge', description: '搜索知识库获取相关信息', parameters: { query: '搜索关键词' } },
  { name: 'get_current_time', description: '获取当前时间', parameters: {} },
];

export function parseToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name) calls.push(parsed);
    } catch {}
  }
  return calls;
}

export async function executeToolCall(call: ToolCall, userId: string): Promise<ToolResult> {
  switch (call.name) {
    case 'get_current_time':
      return { toolName: call.name, result: new Date().toISOString() };
    case 'search_knowledge':
      return { toolName: call.name, result: `搜索 "${call.arguments.query}" 的结果暂不可用` };
    default:
      return { toolName: call.name, result: `未知工具: ${call.name}` };
  }
}