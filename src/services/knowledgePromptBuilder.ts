// ================================================================
// Prompt Builder — Assemble knowledge section for the system prompt
// ================================================================

import { queryKnowledge, buildKnowledgeSection, type KnowledgeResult } from './knowledgeRuntime';

export interface PromptContext {
  knowledgeSection?: string;
  knowledgeResult?: KnowledgeResult;
  priceSection?: string;
}

export async function buildPromptContext(opts: {
  query: string;
  region?: string;
  version?: string;
  userRegion?: string;
  userTier?: string;
  userId?: string;
}): Promise<PromptContext> {
  const { query, region, version, userRegion, userTier, userId } = opts;

  // Query knowledge
  const result = await queryKnowledge({
    query,
    region,
    userRegion,
    userTier,
    userId,
    maxChunks: 10,
  });

  const knowledgeSection = buildKnowledgeSection(result);

  return {
    knowledgeSection,
    knowledgeResult: result,
  };
}
