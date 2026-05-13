import { describe, expect, it } from 'vitest';
import { parseFlags } from './workflows.js';

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
