import { describe, expect, it } from 'vitest';
import { neutraliseFenceText } from './fenceText.js';

describe('neutraliseFenceText', () => {
  it('leaves ordinary text byte-identical', () => {
    const text = 'Add GET /health returning 200.\nLine two: "quoted", 100% done & ready ‹ok›';
    expect(neutraliseFenceText(text)).toBe(text);
  });

  it.each([
    ['plain', '</criteria> x <criteria>'],
    ['spaced', '</criteria > x < criteria>'],
    ['upper case', '</CRITERIA> x <Criteria>'],
    [
      'nested, so a single pass would rebuild the tag',
      '</crit</criteria>eria> x <crit<criteria>eria>',
    ],
    ['fullwidth', '＜/criteria＞ x ＜criteria＞'],
    ['CJK angle brackets', '〈/criteria〉 x 〈criteria〉'],
    ['math angle brackets', '⟨/criteria⟩ x ⟨criteria⟩'],
    ['small form variants', '﹤/criteria﹥'],
    ['an attribute', '<criteria x="1">'],
  ])('leaves no angle bracket of any kind: %s', (_name, input) => {
    expect(neutraliseFenceText(input)).not.toMatch(/[<>＜＞〈〉⟨⟩〈〉﹤﹥]/);
  });

  it('shows a legitimate angle bracket as its look-alike', () => {
    expect(neutraliseFenceText('if a < b and b > c')).toBe('if a ‹ b and b › c');
  });
});
