// ================================================================
// Vector Search Service — Postgres-backed knowledge search
// ================================================================
// Embeddings live in the knowledge Postgres DB (KnowledgeEmbedding
// table) so a Render ephemeral restart never loses the index.
// Vectors are L2-normalized; cosine similarity = dot product.
//
// Embedding generation is currently a deterministic hash-based
// vector (hash embedding); swap generateEmbedding for a real
// embedding API call when one is connected.
// ================================================================

import { prismaKnowledge } from './db';

const EMBEDDING_DIM = 384;
// Scan-time cap so a large index never blows the process out.
const MAX_SCAN_ROWS = 20_000;

// ==================== Embedding Generation ====================

async function generateEmbedding(text: string): Promise<number[]> {
  const embedding = new Array(EMBEDDING_DIM).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
    }
    embedding[Math.abs(hash) % EMBEDDING_DIM] += 1;
  }
  const mag = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0)) || 1;
  return embedding.map((v) => v / mag);
}

// ==================== Index Knowledge ====================

export async function indexKnowledgeChunk(knowledgeId: string, text: string): Promise<void> {
  try {
    const embedding = await generateEmbedding(text);
    await prismaKnowledge.knowledgeEmbedding.upsert({
      where: { knowledgeId },
      create: { knowledgeId, vectorJson: JSON.stringify(embedding), dim: EMBEDDING_DIM },
      update: { vectorJson: JSON.stringify(embedding) },
    });
  } catch (err) {
    console.error('[VecDB] Failed to index:', (err as any)?.message ?? err);
  }
}

// ==================== Search ====================

export interface VecSearchResult {
  knowledgeId: string;
  distance: number;
  score: number;
}

export async function searchByEmbedding(
  query: string,
  topK: number = 10,
): Promise<VecSearchResult[]> {
  try {
    const q = await generateEmbedding(query);

    const rows = await prismaKnowledge.knowledgeEmbedding.findMany({
      select: { knowledgeId: true, vectorJson: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_SCAN_ROWS,
    });
    if (rows.length === 0) return [];

    const scored: VecSearchResult[] = [];
    for (const row of rows) {
      let vec: number[];
      try { vec = JSON.parse(row.vectorJson); } catch { continue; }
      if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) continue;
      let dot = 0;
      for (let i = 0; i < EMBEDDING_DIM; i++) dot += q[i] * vec[i];
      // 两个向量均已 L2 归一化，dot 即 cosine
      const score = Math.max(0, Math.min(1, dot));
      scored.push({ knowledgeId: row.knowledgeId, distance: 1 - score, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  } catch (err) {
    console.warn('[VecDB] search failed:', (err as any)?.message ?? err);
    return [];
  }
}

// ==================== Integration with Knowledge Runtime ====================

export async function vectorSearch(query: string, topK?: number): Promise<VecSearchResult[]> {
  return searchByEmbedding(query, topK);
}
