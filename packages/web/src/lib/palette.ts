/**
 * The design tokens from `app/globals.css`, as literal hex values.
 *
 * Most of the app styles through Tailwind classes or `var(--color-*)` and never
 * needs these. Two surfaces do: Recharts passes `tick={{ fill }}` straight onto
 * an SVG `<text>` as a *presentation attribute*, and React Flow does the same
 * with an edge marker's `color` — and presentation attributes do not resolve
 * `var()`. Those call sites have to inline a literal.
 *
 * Inlining them per call site is what let the DAG edges and the chart chrome
 * drift a whole palette behind `globals.css`, each with a comment naming a
 * token whose value had since changed. One copy lives here, and
 * `palette.test.ts` parses `globals.css` and fails if any entry stops matching.
 */
export const TOKEN = {
  accent300: '#9b8fff',
  accent400: '#7c6cff',
  accent2400: '#34d8c0',
  danger400: '#ff7a7a',
  info400: '#4d8dff',
  info600: '#2d6acc',
  ink500: '#2a3349',
  ink600: '#232a3d',
  ink700: '#141926',
  ink900: '#0c0f17',
  ink950: '#0a0c12',
  paper200: '#e4e8f0',
  paper300: '#c7cdda',
  paper400: '#bac1d1',
  paper500: '#a9b2c6',
  success400: '#46d28a',
  warning400: '#f6b545',
} as const;

/** Shape shared by every theme × palette literal set. */
export type Tokens = { readonly [K in keyof typeof TOKEN]: string };

/**
 * The light theme's values for the same tokens — the `:root[data-theme='light']`
 * block in `globals.css`, checked by `palette.test.ts` like `TOKEN` is.
 */
export const TOKEN_LIGHT: Tokens = {
  accent300: '#5b4ce0',
  accent400: '#5143d6',
  accent2400: '#0b7a6b',
  danger400: '#c53030',
  info400: '#2457c5',
  info600: '#1c46a0',
  ink500: '#e1e5ee',
  ink600: '#e4e7ef',
  ink700: '#ffffff',
  ink900: '#f3f5f9',
  ink950: '#ffffff',
  paper200: '#1d2333',
  paper300: '#353d51',
  paper400: '#475066',
  paper500: '#545d72',
  success400: '#13804b',
  warning400: '#9a5b00',
};

/**
 * The graphite palette's dark values — the `:root[data-palette='graphite']:not([data-theme='light'])`
 * block in `globals.css`. Graphite re-points only the neutral ramps (ink, paper); the accent and
 * status colours are shared with navy, so those entries repeat `TOKEN`'s.
 */
export const TOKEN_GRAPHITE: Tokens = {
  ...TOKEN,
  ink500: '#2a2a30',
  ink600: '#232328',
  ink700: '#161619',
  ink900: '#0c0c0e',
  ink950: '#09090b',
  paper200: '#e5e5e8',
  paper300: '#cbcbd1',
  paper400: '#bdbdc4',
  paper500: '#acacb4',
};

/** The graphite palette's light values — `:root[data-palette='graphite'][data-theme='light']`. */
export const TOKEN_GRAPHITE_LIGHT: Tokens = {
  ...TOKEN_LIGHT,
  ink500: '#e3e3e7',
  ink600: '#e6e6e9',
  ink700: '#ffffff',
  ink900: '#f4f4f5',
  ink950: '#ffffff',
  paper200: '#1f1f23',
  paper300: '#38383f',
  paper400: '#4a4a52',
  paper500: '#5b5b64',
};

/** The literal palette for a painted theme and palette choice. */
export function tokensFor(theme: 'dark' | 'light', palette: 'navy' | 'graphite'): Tokens {
  if (palette === 'graphite') {
    return theme === 'light' ? TOKEN_GRAPHITE_LIGHT : TOKEN_GRAPHITE;
  }
  return theme === 'light' ? TOKEN_LIGHT : TOKEN;
}

/** `TOKEN` key → the custom-property name it mirrors in `globals.css`. */
export const TOKEN_CSS_VAR: Record<keyof typeof TOKEN, string> = {
  accent300: '--color-accent-300',
  accent400: '--color-accent-400',
  accent2400: '--color-accent2-400',
  danger400: '--color-danger-400',
  info400: '--color-info-400',
  info600: '--color-info-600',
  ink500: '--color-ink-500',
  ink600: '--color-ink-600',
  ink700: '--color-ink-700',
  ink900: '--color-ink-900',
  ink950: '--color-ink-950',
  paper200: '--color-paper-200',
  paper300: '--color-paper-300',
  paper400: '--color-paper-400',
  paper500: '--color-paper-500',
  success400: '--color-success-400',
  warning400: '--color-warning-400',
};
