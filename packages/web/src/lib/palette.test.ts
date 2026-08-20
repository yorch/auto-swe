import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOKEN, TOKEN_CSS_VAR } from './palette.js';

/**
 * The reason `lib/palette.ts` is allowed to hold literals at all: this test
 * makes them un-driftable. Change a token in globals.css without changing the
 * literal and this fails, which is exactly what nothing caught when the DAG
 * edges and chart chrome fell a palette behind.
 */
describe('TOKEN', () => {
  const css = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');

  const declared = new Map<string, string>();
  for (const [, name, value] of css.matchAll(/(--color-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
    declared.set(name, value.toLowerCase());
  }

  it('parses the palette out of globals.css', () => {
    expect(declared.size).toBeGreaterThan(20);
  });

  it.each(Object.keys(TOKEN) as (keyof typeof TOKEN)[])(
    '%s matches its custom property in globals.css',
    (key) => {
      const cssVar = TOKEN_CSS_VAR[key];
      expect(declared.get(cssVar), `${cssVar} is not declared in globals.css`).toBeDefined();
      expect(TOKEN[key].toLowerCase()).toBe(declared.get(cssVar));
    }
  );
});

/**
 * The other half of the drift problem: ~50 uses of Tailwind's default colour
 * scales had accumulated against 1899 uses of the project's own tokens, so the
 * error boundary rendered light-theme greys on a dark ground. Nothing flagged
 * it, because a default-scale class is perfectly valid Tailwind.
 */
describe('design tokens are the only colour scale in use', () => {
  const DEFAULT_SCALES = [
    'slate',
    'gray',
    'zinc',
    'neutral',
    'stone',
    'red',
    'orange',
    'amber',
    'yellow',
    'lime',
    'green',
    'emerald',
    'teal',
    'cyan',
    'sky',
    'blue',
    'indigo',
    'violet',
    'purple',
    'fuchsia',
    'pink',
    'rose',
  ];
  // `amber` and `violet` are also project token names, so they are excluded:
  // the project defines --color-amber-400 / --color-violet-400 itself.
  const PROJECT_OWNED = new Set(['amber', 'violet']);
  const scales = DEFAULT_SCALES.filter((s) => !PROJECT_OWNED.has(s));

  it('no component uses a default Tailwind colour scale', () => {
    const root = path.resolve(__dirname, '..');
    const files = globSync('**/*.tsx', { cwd: root }).filter((rel) => !rel.endsWith('.test.tsx'));
    // Directional and side variants count: `border-l-indigo-400` slipped past
    // an earlier version of this guard that only matched the bare prefix.
    const pattern = new RegExp(
      `(?:text|bg|border|from|to|via)(?:-[a-z])?-(?:${scales.join('|')})-\\d{2,3}`
    );

    const offenders = files
      .map((rel) => ({
        hits: readFileSync(path.join(root, rel), 'utf8').match(new RegExp(pattern, 'g')),
        rel,
      }))
      .filter((f) => f.hits)
      .map((f) => `${f.rel}: ${[...new Set(f.hits ?? [])].join(', ')}`);

    expect(offenders).toEqual([]);
  });
});
