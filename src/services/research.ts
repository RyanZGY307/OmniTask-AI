import { prismaKnowledge } from './db';
import { routeModel } from './router';
import { chatWithFallback } from './models';
import { getDynamicModels } from './configSync';

export async function deepResearch(query: string, userId: string, region?: string) {
  const knowledge = await prismaKnowledge.knowledgeBase.findMany({
    where: { isActive: true, OR: [{ title: { contains: query } }, { content: { contains: query } }] },
    take: 5,
  });
  const chunks = await prismaKnowledge.documentChunk.findMany({
    where: {
      isActive: true,
      // 公共分片 + 该用户自己的分片（带 userId 的分片不得被他人研究检索）
      OR: [{ userId: null }, { userId }],
      AND: [{ OR: [{ title: { contains: query } }, { content: { contains: query } }] }],
    },
    take: 5,
  });
  const knowledgeContext = knowledge.map(k => `[${k.category}] ${k.title}: ${k.content.substring(0, 200)}`).join('\n');
  const chunksContext = chunks.map(c => `[${c.sourceType}] ${c.title || 'Doc'}: ${c.content.substring(0, 200)}`).join('\n');
  const fullContext = [knowledgeContext, chunksContext].filter(Boolean).join('\n\n');

  // Auto model selection (research profile) — the router picks primary + fallbacks
  const user = { id: userId, subscriptionTier: 'STANDARD' };
  const decision = routeModel(user, undefined, 'research');
  const messages = [
    { role: 'system' as const, content: '你是一个深度研究助手。基于提供的上下文信息进行深入分析和回答。' },
    { role: 'user' as const, content: `研究问题: ${query}\n\n可用上下文:\n${fullContext || '无相关上下文'}` },
  ];

  const primaryInfo = getDynamicModels()[decision.model];
  let analysis = '';
  // 真实 token：采集 provider 回传的 usage。
  // 原先是 `Math.ceil(analysis.length / 3)` —— 用回答文本长度除 3 估一个
  // token 数，与真实计费口径完全脱节（对话链路已改为只认 provider 数据，
  // 这里此前是漏改的一处）。没有 usage 就是 0，不再编造。
  let providerUsage: any = null;
  let chunkTokens = 0;
  for await (const chunk of chatWithFallback(messages, decision.model, 2000, 0.3, decision.fallbacks)) {
    if (chunk.type === 'chunk' && chunk.content) analysis += chunk.content;
    else if (chunk.type === 'usage' && (chunk as any).usage) providerUsage = (chunk as any).usage;
    else if ((chunk as any).tokens) chunkTokens = (chunk as any).tokens;
  }
  const realTokens = providerUsage?.total_tokens ?? chunkTokens ?? 0;

  return {
    answer: analysis,
    sources: [...new Set([...knowledge.map(k => k.title), ...chunks.map(c => c.title || c.sourceType)])],
    confidence: 0.7,
    tokensUsed: realTokens,
    // 真实输入/输出拆分：只有在 provider 明确给出时才带上，
    // 拿不到就留空（调用方显示未知），不再按 70/30 编造。
    usage: providerUsage
      ? { inputTokens: providerUsage.prompt_tokens, outputTokens: providerUsage.completion_tokens }
      : undefined,
    usedModel: decision.model,
  };
}