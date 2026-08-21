import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../activities/workspace.js';
import { offloadIfLarge, TOOL_OUTPUT_OFFLOAD_DIR } from './toolOutputOffload.js';

/** Minimal Workspace double — no Docker daemon involved. `exec` is the only method under test. */
function makeWorkspace(execImpl: (command: string) => Promise<string>): Workspace {
  return {
    containerId: 'workspace-test',
    destroy: vi.fn(async () => {}),
    exec: vi.fn(execImpl),
    execCapture: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
    gitAuthed: vi.fn(async () => ''),
  };
}

/**
 * Splits an offload excerpt back into its head / tail pieces. Relies on the
 * marker being three `\n`-joined lines sandwiched between head and tail, and
 * on the fixture output containing no newlines of its own — see
 * `buildExcerpt` in toolOutputOffload.ts. `[head, l1, l2, l3, tail]`.
 */
function splitExcerpt(text: string): { head: string; tail: string; markerLines: string[] } {
  const lines = text.split('\n');
  expect(lines.length).toBe(5);
  return { head: lines[0], markerLines: lines.slice(1, 4), tail: lines[4] };
}

function parseElidedCount(markerLines: string[]): number {
  const match = markerLines[0].match(/\[([\d,]+) characters elided/);
  expect(match).not.toBeNull();
  return Number(match?.[1].replace(/,/g, ''));
}

describe('offloadIfLarge', () => {
  it('passes output through unchanged and never touches the workspace when under the limit', async () => {
    const exec = vi.fn(async () => '');
    const workspace = makeWorkspace(exec);
    const output = 'a'.repeat(100);

    const result = await offloadIfLarge({ maxChars: 200, output, toolName: 'bash', workspace });

    expect(result).toEqual({ text: output });
    expect(exec).not.toHaveBeenCalled();
  });

  it('passes output through unchanged at exactly the limit (boundary is inclusive)', async () => {
    const exec = vi.fn(async () => '');
    const workspace = makeWorkspace(exec);
    const output = 'a'.repeat(200);

    const result = await offloadIfLarge({ maxChars: 200, output, toolName: 'bash', workspace });

    expect(result).toEqual({ text: output });
    expect(exec).not.toHaveBeenCalled();
  });

  it('offloads over-limit output to a head+tail excerpt bounded to roughly maxChars', async () => {
    const exec = vi.fn(async (_command: string) => '');
    const workspace = makeWorkspace(exec);
    const output = 'x'.repeat(50_000);
    const maxChars = 5_000;

    const result = await offloadIfLarge({ maxChars, output, toolName: 'bash', workspace });

    expect(result.offload).toBeDefined();
    expect(result.offload?.originalChars).toBe(output.length);
    expect(result.offload?.path.startsWith(`${TOOL_OUTPUT_OFFLOAD_DIR}/`)).toBe(true);

    const { head, tail, markerLines } = splitExcerpt(result.text);
    // Head dominates (decisive info for prose is usually near the end, but a
    // substantial head still orients the model), and both sides are non-empty.
    expect(head.length).toBeGreaterThan(0);
    expect(tail.length).toBeGreaterThan(0);
    expect(head.length).toBeGreaterThan(tail.length);
    // Bounded: total excerpt stays in the neighborhood of maxChars, nowhere
    // near the full 50,000-char original.
    expect(result.text.length).toBeLessThan(maxChars * 1.2);
    expect(markerLines.join('\n')).toContain(result.offload?.path ?? '');

    // Two docker execs: mkdir -p, then the base64-decode write.
    expect(exec).toHaveBeenCalledTimes(2);
    const [firstCommand] = exec.mock.calls[0] ?? [];
    expect(firstCommand).toContain('mkdir -p');
  });

  it('reports an elided count consistent with what was actually shown', async () => {
    const exec = vi.fn(async () => '');
    const workspace = makeWorkspace(exec);
    const output = 'q'.repeat(37_412); // arbitrary non-round size
    const maxChars = 4_000;

    const result = await offloadIfLarge({ maxChars, output, toolName: 'readFile', workspace });

    const { head, tail, markerLines } = splitExcerpt(result.text);
    const elided = parseElidedCount(markerLines);

    expect(head.length + tail.length + elided).toBe(output.length);
  });

  it('falls back to a bounded plain truncation, without throwing, when the write fails', async () => {
    const exec = vi.fn(async (command: string) => {
      if (command.includes('mkdir -p')) {
        return '';
      }
      throw new Error('disk full');
    });
    const workspace = makeWorkspace(exec);
    const output = 'z'.repeat(20_000);
    const maxChars = 3_000;

    const result = await offloadIfLarge({ maxChars, output, toolName: 'bash', workspace });

    expect(result.offload).toBeUndefined();
    // Never the unbounded blob.
    expect(result.text.length).toBeLessThan(output.length);
    expect(result.text.length).toBeLessThan(maxChars * 1.2);
    expect(result.text.startsWith('z'.repeat(maxChars))).toBe(true);
  });

  it('produces distinct offload filenames across two calls in the same workspace', async () => {
    const exec = vi.fn(async () => '');
    const workspace = makeWorkspace(exec);
    const output = 'w'.repeat(10_000);

    const first = await offloadIfLarge({ maxChars: 1_000, output, toolName: 'bash', workspace });
    const second = await offloadIfLarge({ maxChars: 1_000, output, toolName: 'bash', workspace });

    expect(first.offload?.path).toBeDefined();
    expect(second.offload?.path).toBeDefined();
    expect(first.offload?.path).not.toBe(second.offload?.path);
  });
});
