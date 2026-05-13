import { describe, expect, it } from 'vitest';
import {
  assertShellImageAllowed,
  BUILTIN_SHELL_IMAGES,
  isShellImageAllowed,
  ShellImageNotAllowedError,
} from './shellImageAllowlist.js';

describe('shellImageAllowlist', () => {
  it('allows every built-in image regardless of team config', () => {
    for (const img of BUILTIN_SHELL_IMAGES) {
      expect(isShellImageAllowed(img, null)).toBe(true);
      expect(isShellImageAllowed(img, [])).toBe(true);
    }
  });

  it('rejects an unknown image when team allowlist is empty', () => {
    expect(isShellImageAllowed('rust:1.78-alpine', null)).toBe(false);
    expect(isShellImageAllowed('rust:1.78-alpine', [])).toBe(false);
  });

  it('allows a team-extended image with exact match', () => {
    expect(isShellImageAllowed('rust:1.78-alpine', ['rust:1.78-alpine'])).toBe(true);
  });

  it('does not match by prefix — exact-string only', () => {
    expect(isShellImageAllowed('rust:latest', ['rust:1.78-alpine'])).toBe(false);
    expect(isShellImageAllowed('alpine', ['alpine:latest'])).toBe(false);
  });

  it('ignores empty / whitespace / non-string allowlist entries', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate bad entry
    const malformed: any = ['', '   ', null, 42, 'rust:1.78-alpine'];
    expect(isShellImageAllowed('rust:1.78-alpine', malformed)).toBe(true);
    expect(isShellImageAllowed('', malformed)).toBe(false);
  });

  it('rejects blank image strings', () => {
    expect(isShellImageAllowed('', null)).toBe(false);
    expect(isShellImageAllowed('   ', null)).toBe(false);
  });

  it('assertShellImageAllowed throws the typed error for rejection', () => {
    try {
      assertShellImageAllowed('rust:latest', null);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShellImageNotAllowedError);
      expect((err as ShellImageNotAllowedError).image).toBe('rust:latest');
      expect((err as ShellImageNotAllowedError).message).toMatch(/not on the shell-step allowlist/);
    }
  });

  it('assertShellImageAllowed is a no-op for a permitted image', () => {
    expect(() => assertShellImageAllowed('alpine:latest', null)).not.toThrow();
  });
});
