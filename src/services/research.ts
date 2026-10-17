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
  for await (const chunk of chatWithFallback(messages, decision.model, 2000, 0.3, decision.fallbacks)) {
    if (chunk.type === 'chunk' && chunk.content) analysis += chunk.content;
  }

  return {
    answer: analysis,
    sources: [...new Set([...knowledge.map(k => k.title), ...chunks.map(c => c.title || c.sourceType)])],
    confidence: 0.7,
    tokensUsed: Math.ceil(analysis.length / 3),
    usedModel: decision.model,
  };
}