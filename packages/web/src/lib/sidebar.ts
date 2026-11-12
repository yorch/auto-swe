export const SIDEBAR_STORAGE_KEY = 'auto-swe.sidebar';

export const SIDEBAR_INIT_SCRIPT = `(function(){try{document.documentElement.dataset.sidebar=localStorage.getItem('${SIDEBAR_STORAGE_KEY}')==='collapsed'?'collapsed':'expanded';}catch(e){document.documentElement.dataset.sidebar='expanded';}})();`;
