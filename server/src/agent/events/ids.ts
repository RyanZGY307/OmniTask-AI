// ID 与幂等键（docs/interfaces/core-data-model §6.4：幂等键 = stepId + toolCallId）
import { randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** 工具调用幂等键：恢复重放前必须查此键是否已成功执行 */
export function idempotencyKey(stepId: string, toolCallId: string): string {
  return `${stepId}:${toolCallId}`;
}

/** 审批指纹：工具名 + 规范化参数 hash（跨 Run 复用拒绝，DEC-02） */
export function toolFingerprint(toolId: string, normalizedArgsJson: string): string {
  return `${toolId}@${simpleHash(normalizedArgsJson)}`;
}

function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
