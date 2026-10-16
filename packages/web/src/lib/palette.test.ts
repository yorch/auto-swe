import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TOKEN,
  TOKEN_CSS_VAR,
  TOKEN_GRAPHITE,
  TOKEN_GRAPHITE_LIGHT,
  TOKEN_LIGHT,
  type Tokens,
  tokensFor,
} from './palette.js';

/**
 * The reason `lib/palette.ts` is allowed to hold literals at all: this test
 * makes them un-driftable. Change a token in globals.css without changing the
 * literal and this fails, which is exactly what nothing caught when the DAG
 * edges and chart chrome fell a palette behind.
 */
/** The `{ … }` body following `opener` (which ends with its `{`). */
function blockAfter(css: string, opener: string): string {
  const start = css.indexOf(opener);
  if (start === -1) {
    throw new Error(`globals.css has no ${opener}`);
  }
  return css.slice(start + opener.length, css.indexOf('\n}', start));
}

function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--color-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
    out.set(name, value.toLowerCase());
  }
  return out;
}

describe('TOKEN', () => {
  const css = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');
  // The dark values live in the `@theme` block; the light block re-declares the
  // same names, so each theme is read from its own block.
  const declared = declarations(blockAfter(css, '@theme {'));

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
 * `app/global-error.tsx` replaces the root layout when it throws, so it cannot
 * load the stylesheet and inlines its colours as `const INK_800 = '#…'`. Those
 * fell a palette behind once already; hold them to the dark tokens they name.
 */
describe('global-error.tsx colours', () => {
  const css = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');
  const declared = declarations(blockAfter(css, '@theme {'));
  const source = readFileSync(path.resolve(__dirname, '../app/global-error.tsx'), 'utf8');
  const inlined = [...source.matchAll(/const ([A-Z]+)_(\d+) = '(#[0-9a-fA-F]{6})'/g)];

  it('inlines at least the page and text colours', () => {
    expect(inlined.length).toBeGreaterThanOrEqual(4);
  });

  it.each(inlined.map(([, family, step, hex]) => [`${family}_${step}`, family, step, hex]))(
    '%s matches its token',
    (_name, family, step, hex) => {
      const cssVar = `--color-${(family as string).toLowerCase()}-${step}`;
      expect(declared.get(cssVar), `${cssVar} is not declared in globals.css`).toBeDefined();
      expect((hex as string).toLowerCase()).toBe(declared.get(cssVar));
    }
  );
});

describe('TOKEN_LIGHT', () => {
  const css = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');
  const declared = declarations(blockAfter(css, ":root[data-theme='light'] {"));

  it.each(Object.keys(TOKEN) as (keyof typeof TOKEN)[])(
    '%s matches its light-theme custom property in globals.css',
    (key) => {
      const cssVar = TOKEN_CSS_VAR[key];
      expect(
        declared.get(cssVar),
        `${cssVar} is not re-declared for the light theme`
      ).toBeDefined();
      expect(TOKEN_LIGHT[key].toLowerCase()).toBe(declared.get(cssVar));
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

/**
 * Every palette × theme combination, as the browser resolves it: a graphite block
 * re-declares only the neutral ramps, so the accent and status colours fall through
 * to the navy block of the same theme.
 */
const CSS = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');
const NAVY_DARK = declarations(blockAfter(CSS, '@theme {'));
const NAVY_LIGHT = new Map([
  ...NAVY_DARK,
  ...declarations(blockAfter(CSS, ":root[data-theme='light'] {")),
]);
const GRAPHITE_DARK_OWN = declarations(
  blockAfter(CSS, ":root[data-palette='graphite']:not([data-theme='light']) {")
);
const GRAPHITE_LIGHT_OWN = declarations(
  blockAfter(CSS, ":root[data-palette='graphite'][data-theme='light'] {")
);

interface Combo {
  name: string;
  theme: 'dark' | 'light';
  palette: 'navy' | 'graphite';
  declared: Map<string, string>;
  mirror: Tokens;
}

const COMBOS: Combo[] = [
  { declared: NAVY_DARK, mirror: TOKEN, name: 'navy dark', palette: 'navy', theme: 'dark' },
  {
    declared: NAVY_LIGHT,
    mirror: TOKEN_LIGHT,
    name: 'navy light',
    palette: 'navy',
    theme: 'light',
  },
  {
    declared: new Map([...NAVY_DARK, ...GRAPHITE_DARK_OWN]),
    mirror: TOKEN_GRAPHITE,
    name: 'graphite dark',
    palette: 'graphite',
    theme: 'dark',
  },
  {
    declared: new Map([...NAVY_LIGHT, ...GRAPHITE_LIGHT_OWN]),
    mirror: TOKEN_GRAPHITE_LIGHT,
    name: 'graphite light',
    palette: 'graphite',
    theme: 'light',
  },
];

const INK_STEPS = ['950', '900', '800', '700', '600', '500', '400', '300', '200'];
const PAPER_STEPS = ['50', '100', '200', '300', '400', '500', '600'];

function channel(hex: string, offset: number) {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string) {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}
function ratio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('graphite palette blocks', () => {
  const own = [
    ['dark', GRAPHITE_DARK_OWN],
    ['light', GRAPHITE_LIGHT_OWN],
  ] as const;

  it.each(own)('the %s block re-declares the whole ink and paper ramps', (_mode, block) => {
    // A step left out would fall through to navy and bring its blue cast back.
    for (const step of INK_STEPS) {
      expect(block.get(`--color-ink-${step}`), `ink-${step}`).toBeDefined();
    }
    for (const step of PAPER_STEPS) {
      expect(block.get(`--color-paper-${step}`), `paper-${step}`).toBeDefined();
    }
  });

  it.each(own)('the %s ramps are unsaturated grey', (_mode, block) => {
    for (const [name, hex] of block) {
      const rgb = [1, 3, 5].map((o) => Number.parseInt(hex.slice(o, o + 2), 16));
      expect(Math.max(...rgb) - Math.min(...rgb), name).toBeLessThanOrEqual(12);
    }
  });
});

/** Each combination is mirrored exactly, and its text ramp stays readable (WCAG AA). */
describe.each(COMBOS)('$name', ({ declared, mirror, palette, theme }) => {
  const color = (name: string) => {
    const hex = declared.get(`--color-${name}`);
    expect(hex, `--color-${name} is not declared`).toBeDefined();
    return hex as string;
  };

  it('parses out of globals.css', () => {
    expect(declared.size).toBeGreaterThan(20);
  });

  it('is the set tokensFor() returns', () => {
    expect(tokensFor(theme, palette)).toBe(mirror);
  });

  it.each(Object.keys(TOKEN) as (keyof typeof TOKEN)[])('mirrors %s', (key) => {
    expect(mirror[key].toLowerCase()).toBe(declared.get(TOKEN_CSS_VAR[key]));
  });

  it.each(['950', '900', '800', '700', '600', '500'])(
    'paper-300..500 clear 4.5:1 on ink-%s',
    (ink) => {
      for (const paper of ['300', '400', '500']) {
        expect(ratio(color(`paper-${paper}`), color(`ink-${ink}`))).toBeGreaterThanOrEqual(4.5);
      }
    }
  );

  it.each(['950', '900', '800', '700'])('paper-600 clears 4.5:1 on ink-%s', (ink) => {
    expect(ratio(color('paper-600'), color(`ink-${ink}`))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps visible steps between paper 300, 400, 500 and 600', () => {
    const ink = color('ink-800');
    const steps = ['300', '400', '500', '600'].map((p) => ratio(color(`paper-${p}`), ink));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i - 1] - steps[i]).toBeGreaterThan(0.9);
    }
  });

  /**
   * In a dark theme an ink step's lightness follows its role: 950 deepest, 900
   * recessed, 800 the page, 700 the card, then raised surfaces and borders. When
   * 900 sat above 800, a "recessed" block was lighter than the page around it.
   * The light themes keep roles rather than lightness order (the card is white).
   */
  it.runIf(theme === 'dark')('gets lighter from ink-950 to ink-200', () => {
    const values = INK_STEPS.map((s) => luminance(color(`ink-${s}`)));
    for (let i = 1; i < values.length; i++) {
      expect(
        values[i],
        `ink-${INK_STEPS[i]} should be lighter than ink-${INK_STEPS[i - 1]}`
      ).toBeGreaterThan(values[i - 1]);
    }
  });
});
