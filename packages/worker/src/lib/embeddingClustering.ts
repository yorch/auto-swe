/**
 * Shared embedding-clustering helpers for memory consolidation.
 *
 * Both consolidation flows — repo-scoped SWE lessons (`consolidateLessons`) and
 * channel-scoped channel memory (`consolidateChannelMemory`) — greedily cluster
 * semantically-similar `memory_items` by cosine similarity before asking an LLM
 * to synthesise each cluster into 1–2 durable rows. The clustering maths is
 * identical for both; it lives here so a fix or tuning change lands once.
 *
 * Pure + I/O-free (operates on already-parsed vectors) so it is trivially
 * unit-testable and safe to import from any activity.
 */

/** Dot product of two equal-length vectors. */
export function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/** L2 norm of each vector (0 for a null/absent vector). */
export function vectorNorms(embeddings: (number[] | null)[]): number[] {
  return embeddings.map((e) => {
    if (!e) {
      return 0;
    }
    let sum = 0;
    for (const v of e) {
      sum += v * v;
    }
    return Math.sqrt(sum);
  });
}

/**
 * Greedy single-linkage clustering using pre-computed norms. Returns a list of
 * clusters, each as a list of indices into `embeddings`. A null embedding (or
 * one with a zero norm) is its own singleton cluster and never joins another.
 */
export function clusterByEmbedding(
  embeddings: (number[] | null)[],
  norms: number[],
  threshold: number
): number[][] {
  const n = embeddings.length;
  const assigned = new Uint8Array(n);
  const clusters: number[][] = [];

  for (let i = 0; i < n; i++) {
    if (assigned[i] || !embeddings[i]) {
      continue;
    }
    const cluster = [i];
    assigned[i] = 1;
    const ei = embeddings[i];
    for (let j = i + 1; j < n; j++) {
      const ej = embeddings[j];
      if (!ej || norms[i] === 0 || norms[j] === 0) {
        continue;
      }
      if (ei && dotProduct(ei, ej) / (norms[i] * norms[j]) >= threshold) {
        cluster.push(j);
        assigned[j] = 1;
      }
    }
    clusters.push(cluster);
  }

  return clusters;
}
