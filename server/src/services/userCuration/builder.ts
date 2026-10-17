// ================================================================
// Curator Input Builder — 动态输入组装（与系统提示词分离）
// ================================================================
// 只注入「本次整理任务」最少需要的授权数据：当前事件（用户消息+回复摘要）、
// 该用户的相关既有记录（按类别拉取、限量）、适用的约束（保留/隐私规则）、
// 以及输出契约。绝不默认注入用户全部历史。
// ================================================================

import { ALLOWED_CATEGORIES, ALLOWED_SCOPES, ALLOWED_OPERATIONS, ALLOWED_EVIDENCE } from './schema';

export interface CuratorEventInput {
  userMessage: string;
  assistantResponse: string;
  conversationId: string;
  /** 会话中最近少量原始消息（旧→新），含触发事件本身 */
  recentMessages: Array<{ role: string; content: string }>;
}

export interface CuratorExistingInput {
  preferences: Array<{ id: string; type: string; category: string; content: string; confidence: number; updatedAt: string }>;
  requirements: Array<{ id: string; category: string; content: string; priority: string; updatedAt: string }>;
  longTermMemories: Array<{ id: string; type: string; subtype?: string; content: string; importance: number; domain?: string | null; updatedAt: string }>;
}

export interface CuratorInput {
  event: CuratorEventInput;
  existing: CuratorExistingInput;
  constraints: string[];
}

const MAX_EVENT_CHARS = 4000;
const MAX_RECORD_CHARS = 500;
const MAX_RECORDS = 12;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 动态输入 <-> 与系统提示词分离：角色与行为规则在 prompt.ts，此层只是数据。 */
export function buildCuratorUserMessage(input: CuratorInput): string {
  const ev = input.event;
  const recent = ev.recentMessages
    .slice(-4)
    .map((m) => `- ${m.role}: ${truncate(m.content, 300)}`)
    .join('\n');

  const lines: string[] = [];
  lines.push('=== CURRENT EVENT ===');
  lines.push(`conversation_id: ${ev.conversationId}`);
  lines.push(`user: ${truncate(ev.userMessage, MAX_EVENT_CHARS)}`);
  lines.push(`assistant: ${truncate(ev.assistantResponse, MAX_EVENT_CHARS)}`);
  if (recent) {
    lines.push('recent messages (oldest → newest):');
    lines.push(recent);
  }

  lines.push('');
  lines.push('=== EXISTING AUTHORIZED RECORDS FOR THIS USER (subset, most relevant) ===');
  const ex = input.existing;
  if (ex.preferences.length === 0 && ex.requirements.length === 0 && ex.longTermMemories.length === 0) {
    lines.push('(none)');
  } else {
    for (const p of ex.preferences.slice(0, MAX_RECORDS)) {
      lines.push(`- PREFERENCE #${p.id} [${p.type}/${p.category}, confidence=${p.confidence.toFixed(2)}, updated=${p.updatedAt}]: ${truncate(p.content, MAX_RECORD_CHARS)}`);
    }
    for (const r of ex.requirements.slice(0, MAX_RECORDS)) {
      lines.push(`- REQUIREMENT #${r.id} [${r.category}/${r.priority}, updated=${r.updatedAt}]: ${truncate(r.content, MAX_RECORD_CHARS)}`);
    }
    for (const m of ex.longTermMemories.slice(0, MAX_RECORDS)) {
      lines.push(`- LONG_TERM #${m.id} [${m.type}${m.subtype ? '/' + m.subtype : ''}${m.domain ? ', domain=' + m.domain : ''}, importance=${m.importance.toFixed(2)}, updated=${m.updatedAt}]: ${truncate(m.content, MAX_RECORD_CHARS)}`);
    }
  }

  lines.push('');
  lines.push('=== CONSTRAINTS (must be honored) ===');
  for (const c of input.constraints) lines.push(`- ${c}`);

  lines.push('');
  lines.push('=== OUTPUT CONTRACT ===');
  lines.push(`Categories: ${ALLOWED_CATEGORIES.join(', ')}`);
  lines.push(`Allowed scopes: ${ALLOWED_SCOPES.join(', ')}`);
  lines.push(`Allowed operations: ${ALLOWED_OPERATIONS.join(', ')}`);
  lines.push(`Allowed evidence_type: ${ALLOWED_EVIDENCE.join(', ')}`);
  lines.push('Return EXACTLY one JSON object. No prose, no markdown fences.');
  lines.push('If nothing is worth remembering, return {"candidates": []}.');
  lines.push('If an update is needed, cite the record id from above as target_id; never invent ids.');
  lines.push('Schema example:');
  lines.push(
    '{"candidates":[{"category":"USER_PREFERENCE","scope":"USER","operation":"ADD","key":"<snake.case.key>","value":{"content":"...","domain?":"...","project?":"...","attributes?":{}},"confidence":0.9,"importance":0.7,"evidence_type":"explicit","reason":"..."}]}',
  );

  return lines.join('\n');
}
