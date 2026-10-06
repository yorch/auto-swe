import type { EvalResultDto } from '@auto-swe/shared/types/api';

/** Display name for an implementer runtime (`workspace.implementerRuntime`). */
export const IMPLEMENTER_RUNTIME_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code harness',
  mastra: 'Mastra loop',
};

/** The label for a runtime value, the raw value when it is not a known one, null for none. */
export function runtimeLabel(runtime: string | null | undefined): string | null {
  return runtime ? (IMPLEMENTER_RUNTIME_LABELS[runtime] ?? runtime) : null;
}

/**
 * One side of an eval run as a line of text: its agent ref, plus the runtime it
 * was asked to run on when the run overrode it (`implementer@3 on Claude Code harness`).
 */
export function formatArm(ref: string, runtime: string | null | undefined): string {
  const label = runtimeLabel(runtime);
  return label ? `${ref} on ${label}` : ref;
}

/**
 * The runtimes a harness result row records: the candidate arm's in its own
 * column, the baseline arm's beside it in `metadata.baselineRuntime`.
 */
export function resultRuntimes(row: Pick<EvalResultDto, 'metadata' | 'runtime'>): {
  baseline: string | null;
  candidate: string | null;
} {
  const baseline = (row.metadata as { baselineRuntime?: unknown } | null)?.baselineRuntime;
  return {
    baseline: typeof baseline === 'string' ? baseline : null,
    candidate: row.runtime,
  };
}
