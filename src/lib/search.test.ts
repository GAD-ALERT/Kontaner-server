import assert from 'node:assert/strict';
import test from 'node:test';
import { cosineSimilarity, embeddingCorpus, rankByEmbedding } from './search.js';

test('cosineSimilarity handles common vector cases', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2], [1, 2]) - 1) < 1e-12);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([1], [1, 2]), 0);
});

test('rankByEmbedding sorts, filters, and limits results', () => {
  const items = [
    { id: 'best', embedding: [1, 0] },
    { id: 'second', embedding: [0.8, 0.2] },
    { id: 'excluded', embedding: [0, 1] },
    { id: 'missing', embedding: null },
  ];
  const ranked = rankByEmbedding(items, [1, 0], { topK: 2, minScore: 0.2 });
  assert.deepEqual(ranked.map(({ item }) => item.id), ['best', 'second']);
});

test('embeddingCorpus includes fields and respects its cap', () => {
  const corpus = embeddingCorpus({
    displayTitle: 'Kente portrait', tags: ['Kente', 'Portrait'],
    aiInsight: 'A studio portrait', ownerLabel: 'Ama Studio',
  });
  assert.match(corpus, /Kente portrait/);
  assert.match(corpus, /Creator: Ama Studio/);
  assert.ok(embeddingCorpus({ displayTitle: 'x'.repeat(3000), tags: [], ownerLabel: 'A' }).length <= 1800);
});
