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
 * Plain head-only truncation, used only when the offload write itself fails.
 * No file reference is included — there is no file to point at.
 */
function truncatePlain(output: string, maxChars: number): string {
  const elided = output.length - maxChars;
  return (
    `${output.slice(0, maxChars)}\n` +
    `… [${elided.toLocaleString()} characters truncated — the full output could not be saved to a ` +
    'file, so only the start is shown] …'
  );
}

/**
 * Builds a head+tail excerpt of `output` budgeted to roughly `maxChars`
 * total, with a marker in the middle naming the elided character count and
 * where to read the rest.
 *
 * Head+tail rather than head-only: for the outputs this exists to bound —
 * test runs, builds, lockfile dumps — the decisive information (a failure, a
 * summary line, an error at the bottom) is usually at the END. A head-only
 * preview would show the agent a wall of passing setup output and hide
 * exactly the line it needs.
 */
function buildExcerpt(output: string, maxChars: number, filePath: string): string {
  // The marker itself eats into the budget; without reserving room for it the
  // total would creep past maxChars by the marker's own length every time.
  const markerBudget = 300;
  const contentBudget = Math.max(maxChars - markerBudget, Math.floor(maxChars / 2));
  const headChars = Math.max(Math.floor(contentBudget * HEAD_RATIO), 0);
  const tailChars = Math.max(contentBudget - headChars, 0);

  const head = output.slice(0, headChars);
  const tail = tailChars > 0 ? output.slice(output.length - tailChars) : '';
  const elided = output.length - head.length - tail.length;

  const marker = [
    '',
    `… [${elided.toLocaleString()} characters elided — full output was ${output.length.toLocaleString()} ` +
      `characters, over the ${maxChars.toLocaleString()}-character limit] …`,
    `Full output saved to: ${filePath}`,
    // readFile's safePath() rejects absolute paths, so this file cannot be
    // fetched through it — bash is the only way back to the full content.
    `Read more with bash, e.g.: sed -n '100,200p' ${filePath}`,
    '',
  ].join('\n');

  return `${head}${marker}${tail}`;
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
    const b64 = Buffer.from(output).toString('base64');
    await workspace.exec(`echo ${shellQuote(b64)} | base64 -d > ${shellQuote(filePath)}`);
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
