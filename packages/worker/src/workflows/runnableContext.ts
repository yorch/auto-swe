/**
 * Run-context persistence for `RunnableWorkflow`: bounding what a step record
 * carries into history, and spilling oversized context values to artifacts at
 * finalization. Isolate-safe — the only runtime imports are `@temporalio/workflow`
 * and the activity proxies.
 */

import type { Context } from '@auto-swe/shared/workflow/expr';
import { patched } from '@temporalio/workflow';
import { stateActivities } from './runnableActivities.js';

/** Longest string a step record carries; past this it is cut with a note. */
const RECORD_STRING_LIMIT = 8000;

/** Nesting below which a step record's values are summarised rather than copied. */
const RECORD_MAX_DEPTH = 12;

export function boundString(value: string): string {
  return value.length > RECORD_STRING_LIMIT
    ? `${value.slice(0, RECORD_STRING_LIMIT)}… [truncated ${value.length} chars in the step record; the run context keeps the full value]`
    : value;
}

/**
 * A step's inputs/outputs as recorded: oversized strings cut, everything else
 * copied as is. Pure and deterministic — it runs inside the workflow isolate.
 */
export function boundForRecord(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return boundString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= RECORD_MAX_DEPTH) {
    return '[nested too deep for the step record]';
  }
  if (Array.isArray(value)) {
    return value.map((v) => boundForRecord(v, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, boundForRecord(v, depth + 1)])
  );
}

/** Strings longer than this are spilled to a `WorkflowArtifact`. */
const CONTEXT_INLINE_LIMIT = 4000;

/**
 * Per-activity payload budget for spilled values, in UTF-16 code units.
 *
 * Temporal caps how large a single activity input may be, and a run that
 * exceeds it fails at finalization — after all the real work is done. Well
 * under the limit on purpose: this is a floor on round trips, not an attempt to
 * pack the payload.
 */
const SPILL_CHUNK_BUDGET = 1_000_000;

/**
 * Ceiling on how much a single run may spill in total, across all chunks.
 *
 * Activity *inputs* are recorded in workflow history, so spilling is not free
 * the way a plain artifact write would be: every byte sent through
 * `storeContextOverflowBatch` also lands in the run's history, which Temporal
 * caps. The old 20-value cap bounded this incidentally; removing it removed the
 * bound too. Past this, values fall back to truncation — the same degradation
 * the cap used to apply, but keyed on the resource that actually runs out.
 */
const SPILL_TOTAL_BUDGET = 8_000_000;

/**
 * Groups values into chunks whose combined length stays under the budget.
 * A value bigger than the budget on its own occupies a chunk by itself, which
 * is the same payload it had when every value was sent individually.
 */
function chunkBySize<T extends { value: string }>(items: T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length > 0 && size + item.value.length > SPILL_CHUNK_BUDGET) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.value.length;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function truncatedPlaceholder(value: string, note: string): string {
  return `${value.slice(0, CONTEXT_INLINE_LIMIT)}… [truncated ${value.length} bytes — ${note}]`;
}

/**
 * Keep the persisted run snapshot small without losing anything.
 *
 * The snapshot exists so a run is reproducible, and the values most worth
 * keeping — diffs, gate logs, agent output — are exactly the ones that used to
 * be clipped at 4KB. Oversized strings are now written to a `WorkflowArtifact`
 * and replaced by a reference the run viewer can resolve, so `workflow_runs`
 * rows stay small and the content survives.
 *
 * Spilling is best-effort: if the artifact write fails we degrade to the old
 * truncation rather than failing the run at its final step.
 */
export async function snapshotContext(ctx: Context, runId: string): Promise<unknown> {
  const oversized: { path: string; value: string }[] = [];

  // First pass: find what needs spilling, recording each value's path so the
  // placeholder can say where it came from.
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (value.length > CONTEXT_INLINE_LIMIT) {
        oversized.push({ path, value });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}[${i}]`);
      });
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(ctx, '');

  // Batched, but size-bounded. Spilling one value per activity used to cost a
  // round trip each, which is why this was capped at 20 and truncated the rest.
  // Batching removes that reason — but putting *every* value in one activity
  // input would push a large context past Temporal's payload limit and fail the
  // run at its final step, which is strictly worse than the truncation it
  // replaced. So chunk by accumulated size instead.
  //
  // A single value larger than the budget still goes alone, exactly as it did
  // when every value went alone.
  // Past the total ceiling, stop spilling and truncate the remainder — the
  // placeholder says which case applied, so a reader can tell a failed write
  // from a run that simply produced more context than history can hold.
  const spillable: typeof oversized = [];
  let budget = SPILL_TOTAL_BUDGET;
  for (const item of oversized) {
    if (item.value.length > budget) {
      // One value too large for what is left must not stop a smaller one
      // after it from being spilled. Patched: a history recorded before this
      // change stopped at the first value that did not fit, and a replay of
      // it must spill exactly what it spilled then.
      if (patched('spill-budget-skip-oversized')) {
        continue;
      }
      break;
    }
    budget -= item.value.length;
    spillable.push(item);
  }

  const spilled = new Map<string, string>();
  for (const chunk of chunkBySize(spillable)) {
    const refs = await stateActivities.storeContextOverflowBatch({
      runId,
      values: chunk.map(({ path, value }) => ({ content: value, path })),
    });
    chunk.forEach(({ path, value }, i) => {
      const ref = refs[i];
      spilled.set(
        path,
        ref
          ? `[stored as artifact ${ref.artifactId} — ${ref.sizeBytes} bytes]`
          : truncatedPlaceholder(value, 'artifact write failed')
      );
    });
  }

  // Second pass: substitute by path, so two identical strings at different
  // paths cannot collide.
  const rebuild = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      if (value.length <= CONTEXT_INLINE_LIMIT) {
        return value;
      }
      // A value with no `spilled` entry is one the total ceiling stopped at.
      return (
        spilled.get(path) ?? truncatedPlaceholder(value, 'run exceeded its total spill budget')
      );
    }
    if (Array.isArray(value)) {
      return value.map((v, i) => rebuild(v, `${path}[${i}]`));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, rebuild(v, path ? `${path}.${k}` : k)])
      );
    }
    return value;
  };

  return rebuild(ctx, '');
}
