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
  amber400: '#f6b545',
  brick400: '#ff7a7a',
  dust400: '#4d8dff',
  dust600: '#2d6acc',
  ember300: '#9b8fff',
  ember400: '#7c6cff',
  ink500: '#212940',
  ink600: '#1a2030',
  ink700: '#141926',
  ink900: '#0e111a',
  ink950: '#0a0c12',
  moss400: '#46d28a',
  paper200: '#eef1f7',
  paper300: '#c4cad9',
  paper400: '#aeb6c9',
  paper500: '#9aa3b8',
  violet400: '#34d8c0',
} as const;

/** Shape shared by both themes' literal palettes. */
export type Tokens = { readonly [K in keyof typeof TOKEN]: string };

/**
 * The light theme's values for the same tokens — the `:root[data-theme='light']`
 * block in `globals.css`, checked by `palette.test.ts` like `TOKEN` is.
 */
export const TOKEN_LIGHT: Tokens = {
  amber400: '#9a5b00',
  brick400: '#c53030',
  dust400: '#2457c5',
  dust600: '#1c46a0',
  ember300: '#5b4ce0',
  ember400: '#5143d6',
  ink500: '#e1e5ee',
  ink600: '#eceef4',
  ink700: '#ffffff',
  ink900: '#f3f5f9',
  ink950: '#ffffff',
  moss400: '#13804b',
  paper200: '#1d2333',
  paper300: '#353d51',
  paper400: '#475066',
  paper500: '#586176',
  violet400: '#0b7a6b',
};

/** `TOKEN` key → the custom-property name it mirrors in `globals.css`. */
export const TOKEN_CSS_VAR: Record<keyof typeof TOKEN, string> = {
  amber400: '--color-amber-400',
  brick400: '--color-brick-400',
  dust400: '--color-dust-400',
  dust600: '--color-dust-600',
  ember300: '--color-ember-300',
  ember400: '--color-ember-400',
  ink500: '--color-ink-500',
  ink600: '--color-ink-600',
  ink700: '--color-ink-700',
  ink900: '--color-ink-900',
  ink950: '--color-ink-950',
  moss400: '--color-moss-400',
  paper200: '--color-paper-200',
  paper300: '--color-paper-300',
  paper400: '--color-paper-400',
  paper500: '--color-paper-500',
  violet400: '--color-violet-400',
};
