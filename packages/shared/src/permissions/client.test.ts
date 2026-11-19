import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `client.ts` is what the dashboard imports. A value import anywhere in its graph that reaches a
 * `node:` module, the tenant guard or the database client makes `next build` fail on the web
 * image, which no unit test, typecheck or lint notices. Type-only imports are erased and may point
 * anywhere.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = [/^node:/, /tenantGuard/, /\/generated\//, /\/db\.js$/, /^@prisma\//];

function valueImports(source: string): string[] {
  const specs: string[] = [];
  const re = /^(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+'([^']+)'/gms;
  for (const m of source.matchAll(re)) {
    const clause = m[1] ?? '';
    // `export { type A, type B } from` has no runtime import; `export { a, type B } from` does.
    const names = clause
      .replace(/[{}]/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length > 0 && names.every((n) => n.startsWith('type '))) {
      continue;
    }
    specs.push(m[2] as string);
  }
  for (const m of source.matchAll(/^import\s+'([^']+)'/gm)) {
    specs.push(m[1] as string);
  }
  return specs;
}

function walk(file: string, seen: Set<string>, problems: string[]): void {
  if (seen.has(file)) {
    return;
  }
  seen.add(file);
  for (const spec of valueImports(readFileSync(file, 'utf8'))) {
    if (FORBIDDEN.some((re) => re.test(spec))) {
      problems.push(`${file.replace(HERE, '.')} imports ${spec}`);
      continue;
    }
    if (spec.startsWith('.')) {
      walk(resolve(dirname(file), spec.replace(/\.js$/, '.ts')), seen, problems);
    }
  }
}

describe('permissions/client', () => {
  it('reaches no node module, tenant guard or database client through value imports', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    walk(resolve(HERE, 'client.ts'), seen, problems);
    expect(problems).toEqual([]);
    expect(seen.size).toBeGreaterThan(3);
  });

  it('catches a forbidden import (the walker is not vacuous)', () => {
    const sample =
      "import { runUnscoped } from '../lib/tenantGuard.js';\nimport type { X } from 'node:fs';";
    expect(valueImports(sample)).toEqual(['../lib/tenantGuard.js']);
  });
});
