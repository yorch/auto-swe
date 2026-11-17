/** Every character that reads as an angle bracket: ASCII, fullwidth, small, CJK and math forms. */
const ANGLE_BRACKETS = /[<\uFF1C\uFE64\u2329\u3008\u27E8]|[>\uFF1E\uFE65\u232A\u3009\u27E9]/g;

/**
 * Text that sits inside a delimiter in a prompt (`<ticket>`, `<criteria>`) and was written by
 * someone else, or by a model reading what they wrote. No tag is matched, because a pass that
 * removes `</x>` can rebuild one from the pieces around it (`</x</x>>`): every angle bracket
 * becomes the look-alike `‹` or `›`, so the text cannot contain the delimiter in any spelling. A
 * legitimate `<` shows as `‹`.
 */
export function neutraliseFenceText(text: string): string {
  return text.replace(ANGLE_BRACKETS, (c) =>
    /[<\uFF1C\uFE64\u2329\u3008\u27E8]/.test(c) ? '‹' : '›'
  );
}
