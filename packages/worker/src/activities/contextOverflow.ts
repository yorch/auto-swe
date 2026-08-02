import { putArtifact } from '../lib/artifactStore.js';

export interface StoreContextOverflowInput {
  runId: string;
  /** Context path the value came from, e.g. `nodes.implement.output.diff`. */
  path: string;
  content: string;
}

export interface ContextOverflowRef {
  artifactId: string;
  sizeBytes: number;
}

export const CONTEXT_OVERFLOW_KIND = 'context-overflow';

/**
 * Spills one oversized context value into a `WorkflowArtifact` so the run
 * snapshot can reference it instead of clipping it.
 *
 * The snapshot exists to make a run reproducible; silently discarding the tail
 * of a large diff or log defeats that, and those are exactly the values worth
 * keeping. Returns null on failure — losing an artifact must never fail the
 * run, and the caller falls back to the old truncation behaviour.
 */
export async function storeContextOverflow(
  input: StoreContextOverflowInput
): Promise<ContextOverflowRef | null> {
  try {
    const artifact = await putArtifact({
      body: input.content,
      contentType: 'text/plain; charset=utf-8',
      kind: CONTEXT_OVERFLOW_KIND,
      runId: input.runId,
    });
    return { artifactId: artifact.id, sizeBytes: Buffer.byteLength(input.content, 'utf8') };
  } catch {
    return null;
  }
}

export interface StoreContextOverflowBatchInput {
  runId: string;
  values: Array<{ path: string; content: string }>;
}

/**
 * Spills every oversized value in one activity call.
 *
 * The per-value activity above forced the caller to cap how many values it
 * would spill — one Temporal activity per string meant a context with hundreds
 * of large values turned finalization into hundreds of round trips, so the
 * remainder got truncated instead. Batching removes the reason for the cap:
 * cost is now one activity regardless of how many values spill.
 *
 * Per-value failure is isolated: a `null` entry means that one artifact write
 * failed and the caller truncates just that value. Ordering matches `values`,
 * so the caller can zip the results back onto its paths.
 */
export async function storeContextOverflowBatch(
  input: StoreContextOverflowBatchInput
): Promise<Array<ContextOverflowRef | null>> {
  return Promise.all(
    input.values.map((v) =>
      storeContextOverflow({ content: v.content, path: v.path, runId: input.runId })
    )
  );
}
