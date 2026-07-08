/**
 * Cosine similarity ranking for Gemini text-embedding-004 vectors.
 *
 * At demo scale (≤ 5k rows) we happily do this in Node — no pgvector
 * extension required, no query planner surprises. If we ever grow past
 * that, swap this for pgvector's `<=>` operator and an ivfflat index.
 */

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Builds the text we feed to the embedding model.
 * Keep this stable — changing it means re-embedding the catalogue.
 */
export function embeddingCorpus(input: {
  displayTitle: string;
  tags: string[];
  aiInsight?: string | null;
  ownerLabel: string;
}): string {
  const parts = [
    input.displayTitle,
    input.tags.join(', '),
    input.aiInsight ?? '',
    `Creator: ${input.ownerLabel}`,
  ].filter(Boolean);
  return parts.join(' — ').slice(0, 1800); // model limit is ample; we cap to keep costs predictable
}

export interface RankedItem<T> {
  item: T;
  score: number;
}

/** Rank a set of embedded items against a query embedding. */
export function rankByEmbedding<T extends { embedding: number[] | null }>(
  items: T[],
  queryEmbedding: number[],
  { topK = 24, minScore = 0.0 } = {},
): RankedItem<T>[] {
  const scored: RankedItem<T>[] = items
    .filter((it) => Array.isArray(it.embedding) && it.embedding.length > 0)
    .map((it) => ({
      item: it,
      score: cosineSimilarity(queryEmbedding, it.embedding as number[]),
    }))
    .filter((s) => s.score >= minScore);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
