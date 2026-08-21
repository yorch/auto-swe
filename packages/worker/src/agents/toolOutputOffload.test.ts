import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../activities/workspace.js';
import { offloadIfLarge, TOOL_OUTPUT_OFFLOAD_DIR } from './toolOutputOffload.js';

/**
 * Minimal Workspace double — no Docker daemon involved. `exec` runs the
 * `mkdir -p`; `execStdin` carries the file content, which is how the write
 * stays clear of the kernel's single-argv limit.
 */
function makeWorkspace(
  execImpl: (command: string) => Promise<string>,
  execStdinImpl: (command: string, stdin: string | Buffer) => Promise<string> = async () => ''
): Workspace {
  return {
    containerId: 'workspace-test',
    destroy: vi.fn(async () => {}),
    exec: vi.fn(execImpl),
    execCapture: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
    execStdin: vi.fn(execStdinImpl),
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
  it.each([
    { label: 'under the limit', len: 100 },
    { label: 'exactly at the limit (the boundary is inclusive)', len: 200 },
  ])('passes output through and never touches the workspace when $label', async ({ len }) => {
    const exec = vi.fn(async () => '');
    const workspace = makeWorkspace(exec);
    const output = 'a'.repeat(len);

    const result = await offloadIfLarge({ maxChars: 200, output, toolName: 'bash', workspace });

    expect(result).toEqual({ text: output });
    expect(exec).not.toHaveBeenCalled();
  });

  it('offloads over-limit output to a head+tail excerpt bounded by maxChars', async () => {
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
    expect(result.text.length).toBeLessThanOrEqual(maxChars);
    expect(markerLines.join('\n')).toContain(result.offload?.path ?? '');

    // One exec for the mkdir; the content itself travels over stdin.
    expect(exec).toHaveBeenCalledTimes(1);
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
    const exec = vi.fn(async () => '');
    const workspace = makeWorkspace(exec, async () => {
      throw new Error('disk full');
    });
    const output = 'z'.repeat(20_000);
    const maxChars = 3_000;

    const result = await offloadIfLarge({ maxChars, output, toolName: 'bash', workspace });

    expect(result.offload).toBeUndefined();
    // Never the unbounded blob.
    expect(result.text.length).toBeLessThan(output.length);
    expect(result.text.length).toBeLessThanOrEqual(maxChars);
    // Content first, then the note. The note's own length comes out of the
    // budget — that is what keeps the total inside maxChars — so the kept
    // content is necessarily shorter than the limit, and the count the note
    // reports has to match what was actually dropped.
    expect(result.text).toMatch(/^z+\n… \[[\d,]+ characters truncated/);
    const kept = result.text.slice(0, result.text.indexOf('\n…'));
    expect(kept).toBe('z'.repeat(kept.length));
    expect(kept.length).toBeLessThan(maxChars);
    const reported = Number(
      result.text.match(/\[([\d,]+) characters truncated/)?.[1].replace(/,/g, '')
    );
    expect(reported).toBe(output.length - kept.length);
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

  /**
   * The content goes over stdin (`cat > <path>`) rather than as an argv value:
   * `exec` bottoms out in `/bin/sh -c <command>`, and Linux caps a single argv
   * string at `MAX_ARG_STRLEN` (128 KiB). A base64 argv write blew past that on
   * output over ~95 KB — the large test logs this module exists for. A pipe has
   * no such ceiling, so the write is one call at any size.
   */
  describe('stdin write', () => {
    it('sends the whole output in a single write, well past the argv ceiling', async () => {
      const commands: string[] = [];
      const stdins: (string | Buffer)[] = [];
      const workspace = makeWorkspace(
        async (command) => {
          commands.push(command);
          return '';
        },
        async (command, stdin) => {
          commands.push(command);
          stdins.push(stdin);
          return '';
        }
      );
      // Comfortably past the ~95 KB point where the single-shot argv write failed.
      const output = 'y'.repeat(400_000);

      const result = await offloadIfLarge({
        maxChars: 1_000,
        output,
        toolName: 'bash',
        workspace,
      });

      expect(result.offload?.originalChars).toBe(400_000);
      // One write, not a chunk loop — and no command carries the payload.
      expect(stdins).toHaveLength(1);
      for (const command of commands) {
        expect(Buffer.byteLength(command, 'utf8')).toBeLessThan(131_072);
      }
    });

    it('writes the content byte-exactly, including multi-byte characters', async () => {
      const stdins: (string | Buffer)[] = [];
      const workspace = makeWorkspace(
        async () => '',
        async (_command, stdin) => {
          stdins.push(stdin);
          return '';
        }
      );
      const output = `${'π ✓ 🚀 line\n'.repeat(30_000)}FAIL: the decisive last line`;

      await offloadIfLarge({ maxChars: 2_000, output, toolName: 'bash', workspace });

      expect(stdins).toHaveLength(1);
      expect(stdins[0]?.toString()).toBe(output);
    });

    it('truncates the target file rather than appending to it', async () => {
      const writeCommands: string[] = [];
      const workspace = makeWorkspace(
        async () => '',
        async (command) => {
          writeCommands.push(command);
          return '';
        }
      );

      const result = await offloadIfLarge({
        maxChars: 1_000,
        output: 'z'.repeat(300_000),
        toolName: 'bash',
        workspace,
      });

      expect(writeCommands).toHaveLength(1);
      // `>` not `>>`: a re-used path can never concatenate onto a previous run.
      expect(writeCommands[0]).toMatch(/^cat > '/);
      expect(writeCommands[0]).toContain(result.offload?.path ?? '');
    });
  });

  it('keeps the excerpt within maxChars at the smallest configurable limit', async () => {
    const workspace = makeWorkspace(async () => '');
    // 1,000 is the registry schema's minimum, where a fixed marker reservation
    // used to overshoot; `listDirectory` is the longest tool name in the set.
    const maxChars = 1_000;

    const result = await offloadIfLarge({
      maxChars,
      output: 'q'.repeat(2_000_000),
      toolName: 'listDirectory',
      workspace,
    });

    expect(result.text.length).toBeLessThanOrEqual(maxChars);
  });

  it('keeps the failure fallback within maxChars at the smallest configurable limit', async () => {
    const workspace = makeWorkspace(async () => {
      throw new Error('no space left on device');
    });
    const maxChars = 1_000;

    const result = await offloadIfLarge({
      maxChars,
      output: 'q'.repeat(2_000_000),
      toolName: 'listDirectory',
      workspace,
    });

    expect(result.offload).toBeUndefined();
    expect(result.text.length).toBeLessThanOrEqual(maxChars);
  });

  it('never splits a surrogate pair at a head or tail boundary', async () => {
    const workspace = makeWorkspace(async () => '');
    // Every character is astral, so a boundary lands mid-pair unless handled.
    const output = '🚀'.repeat(50_000);

    const result = await offloadIfLarge({
      maxChars: 1_001,
      output,
      toolName: 'bash',
      workspace,
    });

    // A lone surrogate would not survive a UTF-8 round trip intact.
    expect(Buffer.from(result.text, 'utf8').toString('utf8')).toBe(result.text);
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('keeps the last line of realistic multi-line output, where the failure is', async () => {
    const workspace = makeWorkspace(async () => '');
    const output = `${'ok some passing setup line\n'.repeat(5_000)}FAIL src/thing.test.ts > it breaks`;

    const result = await offloadIfLarge({
      maxChars: 2_000,
      output,
      toolName: 'bash',
      workspace,
    });

    // The whole point of head+tail over head-only.
    expect(result.text).toContain('FAIL src/thing.test.ts > it breaks');
    expect(result.text).toContain('ok some passing setup line');
    expect(result.text.length).toBeLessThanOrEqual(2_000);
  });
});
