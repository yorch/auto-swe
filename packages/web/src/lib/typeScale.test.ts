import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every font size in the dashboard comes from the pinned steps in globals.css
 * (`text-2xs` … `text-5xl`). One-off `text-[13.5px]` sizes are how the app
 * ended up with a dozen sizes half a pixel apart, which reads as "slightly off"
 * rather than as hierarchy. Add a step to the scale if one is genuinely missing.
 */
describe('type scale', () => {
  it('no component sets an arbitrary pixel font size', () => {
    const root = path.resolve(__dirname, '..');
    const files = globSync('**/*.{ts,tsx}', { cwd: root }).filter(
      (rel) => !/\.test\.tsx?$/.test(rel)
    );
    // Fixed units only. A relative `em` size is allowed: inline code at `0.85em`
    // follows whatever text it sits in, which no fixed step can do.
    const pattern = /text-\[\d+(?:\.\d+)?(?:px|rem)\]/g;

    const offenders = files
      .map((rel) => ({ hits: readFileSync(path.join(root, rel), 'utf8').match(pattern), rel }))
      .filter((f) => f.hits)
      .map((f) => `${f.rel}: ${[...new Set(f.hits ?? [])].join(', ')}`);

    expect(offenders).toEqual([]);
  });

  it('pins every step in globals.css to whole pixels', () => {
    const css = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');
    for (const step of ['2xs', 'xs', 'sm', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl']) {
      expect(css, `--text-${step} is not pinned`).toMatch(
        new RegExp(`--text-${step}:\\s*\\d+px;[\\s\\S]*?--text-${step}--line-height:\\s*\\d+px;`)
      );
    }
  });
});
