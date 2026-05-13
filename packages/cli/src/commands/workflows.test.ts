import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFlags, runWorkflowsCommand } from './workflows.js';

const ENV = { apiUrl: 'http://gw', token: 't' };

describe('parseFlags', () => {
  it('returns positional args only when no flags are present', () => {
    expect(parseFlags(['a', 'b'])).toEqual({ flags: {}, positional: ['a', 'b'] });
  });

  it('supports --foo=bar inline form', () => {
    expect(parseFlags(['--name=my-template'])).toEqual({
      flags: { name: 'my-template' },
      positional: [],
    });
  });

  it('supports --foo bar space-separated form', () => {
    expect(parseFlags(['--name', 'my-template', 'extra'])).toEqual({
      flags: { name: 'my-template' },
      positional: ['extra'],
    });
  });

  it('supports short -o flag for output paths', () => {
    expect(parseFlags(['workflow-name', '-o', 'out.json'])).toEqual({
      flags: { o: 'out.json' },
      positional: ['workflow-name'],
    });
  });

  it('treats flag without value as boolean "true"', () => {
    expect(parseFlags(['--dry-run'])).toEqual({
      flags: { 'dry-run': 'true' },
      positional: [],
    });
  });

  it('does not consume a following flag as a value for the prior flag', () => {
    expect(parseFlags(['--a', '--b=2'])).toEqual({
      flags: { a: 'true', b: '2' },
      positional: [],
    });
  });

  it('mixes positionals + flags in any order', () => {
    expect(parseFlags(['list', '--team=payments', 'unused'])).toEqual({
      flags: { team: 'payments' },
      positional: ['list', 'unused'],
    });
  });
});

describe('runWorkflowsCommand flag validation', () => {
  let stderrWrites: string[];
  let originalWrite: typeof process.stderr.write;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    stderrWrites = [];
    originalWrite = process.stderr.write;
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrWrites.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    originalFetch = globalThis.fetch;
    // Default fetch never invoked — these tests should reject before hitting the API.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('fetch should not be called when flags are invalid');
    }) as typeof fetch;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    globalThis.fetch = originalFetch;
  });

  it('rejects --version without a value', async () => {
    // parseFlags assigns 'true' when a flag has no following value
    const code = await runWorkflowsCommand(['show', 'name', '--version'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('positive integer');
  });

  it('rejects --version with a non-numeric value', async () => {
    const code = await runWorkflowsCommand(['show', 'name', '--version=abc'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('positive integer');
  });

  it('rejects --version=0', async () => {
    const code = await runWorkflowsCommand(['show', 'name', '--version=0'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('positive integer');
  });

  it('rejects -o without a value to avoid writing to a file named "true"', async () => {
    const code = await runWorkflowsCommand(['export', 'name', '-o'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('requires a file path');
  });
});
