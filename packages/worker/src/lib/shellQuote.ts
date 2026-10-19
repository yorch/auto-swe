/**
 * POSIX single-quote a string for interpolation into a `sh -c` script.
 * The only escaping single quotes support — end quote, escaped quote,
 * reopen — applied to every `'` in the input.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
