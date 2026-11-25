/**
 * The one rule for a branch or tag name an external repository is read at. Pure on purpose (no
 * imports): the skill-source reader (`normaliseLocation`) and the bundle validator
 * (`pluginRefProblem`) both use it, so what a bundle accepts at validation time cannot drift from
 * what the install later reads.
 */
export function validRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 255 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
    !/[\u0000- \u007f~^:?*[\\]/.test(ref) &&
    !ref.includes('..') &&
    !ref.split('/').includes('.') &&
    !ref.startsWith('-') &&
    !ref.startsWith('/') &&
    !ref.endsWith('/') &&
    !ref.includes('//') &&
    !ref.endsWith('.lock')
  );
}
