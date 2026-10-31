import { describe, expect, it } from 'vitest';
import { packageManagerPins } from './packageManagerPins.js';

describe('packageManagerPins', () => {
  it('maps each packageManager pin to its npm package', () => {
    expect(packageManagerPins('{"packageManager":"pnpm@10.34.7"}')).toEqual([
      { name: 'pnpm', version: '10.34.7' },
    ]);
    expect(packageManagerPins('{"packageManager":"yarn@1.22.22"}')).toEqual([
      { name: 'yarn', version: '1.22.22' },
    ]);
    expect(packageManagerPins('{"packageManager":"yarn@4.18.1+sha224.abc"}')).toEqual([
      { name: '@yarnpkg/cli-dist', version: '4.18.1' },
    ]);
    expect(packageManagerPins('{"packageManager":"npm@11.9.0"}')).toEqual([
      { name: 'npm', version: '11.9.0' },
    ]);
  });
  it('returns [] for missing or invalid input', () => {
    expect(packageManagerPins('{}')).toEqual([]);
    expect(packageManagerPins('not json')).toEqual([]);
    expect(packageManagerPins('{"packageManager":"bun@1.0"}')).toEqual([]);
    expect(packageManagerPins('{"packageManager":"npm@latest"}')).toEqual([]);
  });
});
