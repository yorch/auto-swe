import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEFINITION = 'lib/gitIdentity.ts';
const FALLBACKS = ['auto-swe@localhost', "user.name='auto-swe'"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('hardcoded git identity', () => {
  it('appears in no worker source file but the DEFAULT_GIT_IDENTITY definition', () => {
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const rel = relative(SRC, file);
      const text = readFileSync(file, 'utf8');
      return FALLBACKS.filter((literal) => text.includes(literal))
        .filter(() => rel !== DEFINITION)
        .map((literal) => `${rel}: ${literal}`);
    });
    expect(offenders).toEqual([]);
  });

  it('is defined in the definition file once for the author and once for the committer', () => {
    const text = readFileSync(join(SRC, DEFINITION), 'utf8');
    expect(text.split('auto-swe@localhost')).toHaveLength(3);
  });
});
