/**
 * Theme constants shared by the server layout (the pre-paint script) and the
 * client theme store. Deliberately not a client module: the layout is a server
 * component and must receive the script as a plain string.
 *
 * Two independent choices make up what is painted:
 *   - the theme (light / dark / follow the system), written to `data-theme`;
 *   - the palette (navy / graphite), written to `data-palette` — navy is the
 *     default and carries no attribute, graphite sets `data-palette="graphite"`.
 * `app/globals.css` holds one token block per palette × theme.
 */

/** What the user chose. `system` follows the operating system's light/dark setting. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** The colour family of the surfaces and text: navy (blue-tinted) or graphite (neutral grey). */
export type PalettePreference = 'navy' | 'graphite';

/** localStorage key; the pre-paint script and the theme store read the same key. */
export const THEME_STORAGE_KEY = 'auto-swe.theme';

/** localStorage key for the palette; read by the pre-paint script and the theme store. */
export const PALETTE_STORAGE_KEY = 'auto-swe.palette';

/**
 * Applies the stored preferences before React hydrates, so the first paint is
 * already in the right theme and palette. It must stay in step with `resolve()`
 * and `readPalette()` in `stores/themeStore.ts`. The defaults are dark and navy —
 * the dashboard's look before either choice existed — so nobody's screen changes
 * until they choose. The palette is read in its own `try` so a failure there
 * cannot leave the theme unset.
 */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement;try{var p=localStorage.getItem('${THEME_STORAGE_KEY}');var t=p==='light'||p==='dark'?p:p==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):'dark';d.dataset.theme=t;}catch(e){d.dataset.theme='dark';}try{if(localStorage.getItem('${PALETTE_STORAGE_KEY}')==='graphite'){d.dataset.palette='graphite';}else{delete d.dataset.palette;}}catch(e){}})();`;

/** Writes a palette choice onto `<html>`; navy is the attribute-free default. */
export function applyPalette(palette: PalettePreference): void {
  if (palette === 'graphite') {
    document.documentElement.dataset.palette = 'graphite';
  } else {
    delete document.documentElement.dataset.palette;
  }
}
