import crypto from 'node:crypto';
import type { Workspace } from '../activities/workspace.js';
import { shellQuote } from '../activities/workspace.js';
import { getErrorMessage } from '../lib/errors.js';

/**
 * Directory oversized tool output is written to. Deliberately a sibling of
 * `/workspace/target-repo` (see `createWorkspace` in `activities/workspace.ts`,
 * which runs `exec` with `-w /workspace/target-repo`), not a path inside it —
 * anything written here is invisible to `git status`/`git add -A` and can
 * never leak into the diff the implementer commits.
 */
export const TOOL_OUTPUT_OFFLOAD_DIR = '/workspace/.tool-output';

/** Roughly how much of the excerpt budget goes to the head vs. the tail. */
const HEAD_RATIO = 0.6;

/** Monotonic tie-breaker so two offloads in the same millisecond never collide. */
let offloadCounter = 0;

export interface OffloadMetadata {
  /** Absolute path inside the workspace container the full output was written to. */
  path: string;
  /** Length of the original, un-truncated output. */
  originalChars: number;
}

export interface OffloadResult {
  /** The text to hand back to the model — unchanged, or a bounded excerpt. */
  text: string;
  /** Present only when a file was actually written. */
  offload?: OffloadMetadata;
}

/**
 * Splits an offload result into the value the tool returns and the value the
 * tracer records: identical except that an offloaded call also carries where
 * the full output went and how big it was.
 *
 * Each tool names its payload differently (`content` / `listing` / `output`),
 * so the key is a parameter — that difference is the only thing that varied
 * across the four call sites that used to inline this.
 */
export function packOffload<K extends string>(
  key: K,
  offloaded: OffloadResult
): { result: Record<K, string>; outputJson: Record<string, unknown> } {
  const result = { [key]: offloaded.text } as Record<K, string>;
  return {
    outputJson: offloaded.offload ? { ...result, offload: offloaded.offload } : result,
    result,
  };
}

export interface OffloadParams {
  output: string;
  /** Tool name, folded into the offload filename purely for operator readability. */
  toolName: string;
  workspace: Workspace;
  maxChars: number;
}

/** Builds a filename that can't collide across calls within one workspace. */
function offloadFileName(toolName: string): string {
  offloadCounter += 1;
  const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool';
  return `${Date.now()}-${offloadCounter}-${crypto.randomBytes(4).toString('hex')}-${safeName}.txt`;
}

/**
 * A slice boundary nudged off the middle of a surrogate pair.
 *
 * `slice` counts UTF-16 code units, so a cut can land between the two halves of
 * an astral-plane character (emoji are the common case in test output) and emit
 * a lone surrogate — which survives until something tries to encode it, then
 * becomes U+FFFD in the LLM payload or the trace row. Moving the boundary by one
 * unit costs nothing and removes the class.
 */
function headEnd(s: string, end: number): number {
  const i = Math.min(end, s.length);
  const c = s.charCodeAt(i - 1);
  return c >= 0xd800 && c <= 0xdbff ? i - 1 : i;
}

function tailStart(s: string, start: number): number {
  const i = Math.max(start, 0);
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff ? i + 1 : i;
}

/**
 * Plain head-only truncation, used only when the offload write itself fails.
 * No file reference is included — there is no file to point at.
 *
 * The note is rendered before the budget is spent so its real length is
 * subtracted rather than guessed, keeping the result within `maxChars`.
 */
function truncatePlain(output: string, maxChars: number): string {
  const note = (elided: number) =>
    `\n… [${elided.toLocaleString()} characters truncated — the full output could not be saved ` +
    'to a file, so only the start is shown] …';
  // Sized against the largest count it could ever render, so the final note —
  // whose count is necessarily smaller — can only be shorter, never longer.
  const keep = Math.max(maxChars - note(output.length).length, 0);
  const head = output.slice(0, headEnd(output, keep));
  return `${head}${note(output.length - head.length)}`;
}

/**
 * Builds a head+tail excerpt of `output` bounded by `maxChars`, with a marker
 * in the middle naming the elided character count and where to read the rest.
 *
 * Head+tail rather than head-only: for the outputs this exists to bound —
 * test runs, builds, lockfile dumps — the decisive information (a failure, a
 * summary line, an error at the bottom) is usually at the END. A head-only
 * preview would show the agent a wall of passing setup output and hide
 * exactly the line it needs.
 */
function buildExcerpt(output: string, maxChars: number, filePath: string): string {
  const marker = (elided: number) =>
    [
      '',
      `… [${elided.toLocaleString()} characters elided — the original was ${output.length.toLocaleString()} ` +
        `characters, over the ${maxChars.toLocaleString()}-character limit] …`,
      // `readFile` is offloaded too, so this marker can land in the middle of
      // what the model is treating as a file's literal contents. Say plainly
      // that it is not part of them, or the model may copy it back out through
      // `writeFile` and commit the notice into the repo.
      `This notice was inserted here and is not part of the content. Full output: ${filePath}`,
      // readFile's safePath() rejects absolute paths, so this file cannot be
      // fetched through it — bash is the only way back to the full content.
      `Read the rest with bash, e.g.: sed -n '100,200p' ${filePath}`,
      '',
    ].join('\n');

  // Reserve the marker's *rendered* length, not a guessed constant. Sizing
  // against the largest count it could carry means the marker finally emitted —
  // whose count is necessarily smaller — can only be shorter, so the assembled
  // excerpt is bounded by maxChars rather than "roughly" it. A fixed guess
  // overshot at small maxChars, exactly where the bound matters most.
  const contentBudget = Math.max(maxChars - marker(output.length).length, 0);
  const headChars = Math.floor(contentBudget * HEAD_RATIO);
  const tailChars = contentBudget - headChars;

  const head = output.slice(0, headEnd(output, headChars));
  const tail = tailChars > 0 ? output.slice(tailStart(output, output.length - tailChars)) : '';

  return `${head}${marker(output.length - head.length - tail.length)}${tail}`;
}

/**
 * Offloads `output` to a file in the workspace when it exceeds `maxChars`,
 * returning a bounded excerpt plus a pointer instead of the full blob.
 * Under the threshold this is a pure passthrough — no exec, no file.
 *
 * Failure-isolated by design: a write failure here must never fail the
 * calling tool or leak the unbounded blob into context. It falls back to a
 * plain truncation instead.
 */
export async function offloadIfLarge(params: OffloadParams): Promise<OffloadResult> {
  const { output, toolName, workspace, maxChars } = params;
  if (output.length <= maxChars) {
    return { text: output };
  }

  const filePath = `${TOOL_OUTPUT_OFFLOAD_DIR}/${offloadFileName(toolName)}`;
  try {
    await workspace.exec(`mkdir -p ${shellQuote(TOOL_OUTPUT_OFFLOAD_DIR)}`);
    // Stream over stdin rather than passing the blob as an argv value: a single
    // argv string is capped by the kernel (E2BIG at ~128 KiB), which is exactly
    // the size range this module exists to handle.
    await workspace.execStdin(`cat > ${shellQuote(filePath)}`, output);
  } catch (err: unknown) {
    // Best-effort: log for operator visibility, but never throw and never
    // fall through to returning the unbounded `output` — that would defeat
    // the whole point of this module on exactly the runs where it matters
    // most (a full disk, a read-only workspace, a container mid-teardown).
    console.warn(`[toolOutputOffload] failed to write ${filePath}: ${getErrorMessage(err)}`);
    return { text: truncatePlain(output, maxChars) };
  }

  return {
    offload: { originalChars: output.length, path: filePath },
    text: buildExcerpt(output, maxChars, filePath),
  };
}
