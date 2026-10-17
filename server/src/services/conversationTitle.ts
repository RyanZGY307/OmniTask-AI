// ================================================================
// Conversation Title — 新会话首条消息后用 Agnes 2.5-flash 生成短标题
// 替换占位标题「新对话」。Fire-and-forget：不阻塞主回复。
// 降级链：Agnes 短标题 → 消息前 20 字。0 积分（不经计费路径）。
// ================================================================

import { callAgnes } from './scenarioWorkers/agnesCaller';
import { prismaConversation } from './db';

const PLACEHOLDER_TITLES = new Set(['新对话', 'New Conversation', '']);

export async function maybeGenerateConversationTitle(conversationId: string, userText: string): Promise<void> {
  try {
    if (!userText || !userText.trim()) return;
    const conv = await prismaConversation.conversation.findUnique({ where: { id: conversationId } });
    if (!conv || !PLACEHOLDER_TITLES.has(conv.title || '')) return;

    let clean = '';
    try {
      const title = await callAgnes(
        '你是对话标题助手。根据用户的第一条消息，生成一个 6 到 14 个字的中文标题，概括这段对话的主题（不要输出“新对话”“你好”这类空泛词，也不要只输出一个数字或单个字）。只输出标题本身，不要标点、引号或前缀。',
        userText.trim().slice(0, 500),
        { model: 'agnes-2.5-flash', temperature: 0.3, maxTokens: 40, timeoutMs: 8000 },
      );
      const t = String(title || '').trim().replace(/[\n"'「」『』《》【】]/g, '');
      // 过短/纯数字/空泛的标题不可用，退回消息截断
      if (t.length >= 4 && !/^[\d\s]+$/.test(t) && !/^(新对话|你好|hi|hello)$/i.test(t)) clean = t.slice(0, 16);
    } catch {
      // 无 Agnes key / 超时：走下方消息截断降级
    }
    const finalTitle = clean || userText.trim().slice(0, 20);
    await prismaConversation.conversation.update({ where: { id: conversationId }, data: { title: finalTitle } });
  } catch {
    // DB 抖动等：静默降级，占位标题保留，下轮可再试
  }
}
