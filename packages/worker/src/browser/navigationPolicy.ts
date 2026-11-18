/**
 * Why the browser must not open `rawUrl`, or null when it may. Only http and https pages, and
 * `about:blank`, are opened: `file:`, `chrome:`, `view-source:`, `javascript:`, `ftp:`, `data:` and
 * `blob:` are refused before any navigation. `browser_navigate` checks this and the driver
 * (`driver.mjs`, `navigationRefusal`) checks the same rule again, so a caller that skips the tool
 * still cannot reach those schemes. The two copies are kept in step by `navigationPolicy.test.ts`.
 */
export function navigationRefusal(rawUrl: string): string | null {
  if (rawUrl.trim().toLowerCase() === 'about:blank') {
    return null;
  }
  let protocol: string;
  try {
    protocol = new URL(rawUrl).protocol;
  } catch {
    return 'the URL is not valid; only absolute http and https URLs can be opened';
  }
  return protocol === 'http:' || protocol === 'https:'
    ? null
    : `the ${protocol} scheme cannot be opened; only http and https URLs can`;
}
