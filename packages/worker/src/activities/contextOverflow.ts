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
