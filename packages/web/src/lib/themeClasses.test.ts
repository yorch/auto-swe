import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A colour utility naming a shade the theme does not define compiles to
 * nothing: Tailwind emits no rule, nothing warns, and the element silently
 * renders without its background or text colour. The status families define
 * only 400 and 600, so `bg-brick-900` or `text-moss-300` look plausible and
 * produce bare, uncoloured pills. `amber` and `violet` are worse — Tailwind's
 * defaults fill their other shades, so `violet-300` renders purple next to a
 * theme `violet-400` that is teal.
 *
 * This fails on any colour utility whose `family-shade` is not declared in
 * globals.css `@theme`, including families the theme never declares at all
 * (Tailwind's `red`, `gray`, …, or an invented `brand`).
 */
const SRC = path.resolve(__dirname, '..');

const UTILITY =
  /\b(?:text|bg|border(?:-[trblxy])?|ring|divide|from|via|to|fill|stroke|accent|outline|decoration|shadow|placeholder|caret)-([a-z]+)-(50|[1-9]00|950)\b/g;

describe('theme colour classes', () => {
  const css = readFileSync(path.join(SRC, 'app/globals.css'), 'utf8');
  const theme = css.slice(css.indexOf('@theme'), css.indexOf('}', css.indexOf('@theme')));
  const declared = new Set(
    [...theme.matchAll(/--color-([a-z]+-(?:50|[1-9]00|950)):/g)].map(([, name]) => name)
  );

  it('parses the colour tokens out of the @theme block', () => {
    expect(declared.has('brick-400')).toBe(true);
    expect(declared.has('brick-900')).toBe(false);
  });

  it('uses only shades the theme declares', () => {
    const offenders: string[] = [];
    const files = globSync('{app,components,hooks,lib,stores}/**/*.{ts,tsx}', { cwd: SRC });
    for (const file of files) {
      if (file.includes('.test.')) {
        continue;
      }
      const lines = readFileSync(path.join(SRC, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const [match, family, shade] of line.matchAll(UTILITY)) {
          if (!declared.has(`${family}-${shade}`)) {
            offenders.push(`${file}:${i + 1} ${match}`);
          }
        }
      });
    }
    expect(offenders, 'colour classes with no @theme token (they render uncoloured)').toEqual([]);
  });
});
