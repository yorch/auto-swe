/**
 * Theme constants shared by the server layout (the pre-paint script) and the
 * client theme store. Deliberately not a client module: the layout is a server
 * component and must receive the script as a plain string.
 */

/** What the user chose. `system` follows the operating system's light/dark setting. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** localStorage key; the pre-paint script and the theme store read the same key. */
export const THEME_STORAGE_KEY = 'auto-swe.theme';

/**
 * Applies the stored preference before React hydrates, so the first paint is
 * already in the right theme. It must stay in step with `resolve()` in
 * `stores/themeStore.ts`. The default is dark — the dashboard's look before the
 * light theme existed — so nobody's screen changes until they choose.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem('${THEME_STORAGE_KEY}');var t=p==='light'||p==='dark'?p:p==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):'dark';document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;
