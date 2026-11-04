// 文本 Action/Observation 协议解析（模型无原生 tool-calling 时的方案 B）
// 协议（SWE-agent 式）：模型输出含 ```action\n{"name":"...","args":{...}}\n``` 代码块。
// 解析为 ToolCallRequest；解析失败 = 坏协议（返回 error 而非崩溃），由 AgentLoop 转 advisor/询问。
import type { ToolCallRequest } from './types';

export interface ParseResult {
  calls: ToolCallRequest[];
  errors: string[];            // 坏协议明细（可观测）
  residualText: string;        // 去掉 action 块后的正文（作为最终答复时用）
}

export function parseActionProtocol(text: string): ParseResult {
  const calls: ToolCallRequest[] = [];
  const errors: string[] = [];
  const re = /```action\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    try {
      const parsed = JSON.parse(body) as { name?: unknown; args?: unknown; id?: unknown };
      if (typeof parsed.name !== 'string') {
        errors.push(`action #${idx}: 缺少 name 字段`);
      } else {
        calls.push({
          id: typeof parsed.id === 'string' ? parsed.id : `call_${idx}_${stableId(parsed.name)}`,
          name: parsed.name,
          args: (parsed.args ?? {}) as Record<string, unknown>,
        });
      }
    } catch {
      errors.push(`action #${idx}: 非法 JSON（${body.slice(0, 60)}…）`);
    }
    idx++;
  }
  return { calls, errors, residualText: text.replace(re, '').trim() };
}

function stableId(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
