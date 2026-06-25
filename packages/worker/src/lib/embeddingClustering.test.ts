import { describe, expect, it } from 'vitest';
import { clusterByEmbedding, dotProduct, vectorNorms } from './embeddingClustering.js';

describe('dotProduct', () => {
  it('sums element-wise products', () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(1 * 4 + 2 * 5 + 3 * 6);
  });

  it('is zero for orthogonal vectors', () => {
    expect(dotProduct([1, 0], [0, 1])).toBe(0);
  });
});

describe('vectorNorms', () => {
  it('computes the L2 norm of each vector', () => {
    expect(
      vectorNorms([
        [3, 4],
        [1, 0],
      ])
    ).toEqual([5, 1]);
  });

  it('returns 0 for a null vector', () => {
    expect(vectorNorms([null, [3, 4]])).toEqual([0, 5]);
  });
});

describe('clusterByEmbedding', () => {
  it('groups vectors above the cosine threshold into one cluster', () => {
    // Two near-identical vectors + one orthogonal one.
    const embeddings = [
      [1, 0],
      [1, 0.01],
      [0, 1],
    ];
    const clusters = clusterByEmbedding(embeddings, vectorNorms(embeddings), 0.99);

    // The two collinear vectors cluster; the orthogonal one is its own singleton.
    expect(clusters).toContainEqual([0, 1]);
    expect(clusters).toContainEqual([2]);
    expect(clusters).toHaveLength(2);
  });

  it('keeps dissimilar vectors in separate singleton clusters', () => {
    const embeddings = [
      [1, 0],
      [0, 1],
    ];
    const clusters = clusterByEmbedding(embeddings, vectorNorms(embeddings), 0.9);

    expect(clusters).toHaveLength(2);
    expect(clusters).toEqual([[0], [1]]);
  });

  it('treats a null embedding (or zero norm) as its own singleton, never joining', () => {
    const embeddings = [[1, 0], null, [1, 0]];
    const clusters = clusterByEmbedding(embeddings, vectorNorms(embeddings), 0.5);

    // The two real vectors cluster; the null is skipped entirely (never assigned).
    expect(clusters).toContainEqual([0, 2]);
    expect(clusters.flat()).not.toContain(1);
  });
});
