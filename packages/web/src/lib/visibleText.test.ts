import { describe, expect, it } from 'vitest';
import { visibleOrNull, visibleText } from './visibleText';

describe('visibleText', () => {
  it.each([
    ['\u202e', '⟨U+202E⟩'],
    ['\u202a', '⟨U+202A⟩'],
    ['\u2066', '⟨U+2066⟩'],
    ['\u2069', '⟨U+2069⟩'],
    ['\u200b', '⟨U+200B⟩'],
    ['\u200f', '⟨U+200F⟩'],
    ['\u2060', '⟨U+2060⟩'],
    ['\u2064', '⟨U+2064⟩'],
    ['\ufeff', '⟨U+FEFF⟩'],
    ['\u061c', '⟨U+061C⟩'],
    ['\u180e', '⟨U+180E⟩'],
    ['\u2028', '⟨U+2028⟩'],
    ['\u0000', '⟨U+0000⟩'],
    ['\u001b', '⟨U+001B⟩'],
    ['\u007f', '⟨U+007F⟩'],
    ['\u0085', '⟨U+0085⟩'],
  ])('shows %j as %s', (input, shown) => {
    expect(visibleText(`a${input}b`)).toBe(`a${shown}b`);
  });

  it('keeps ordinary text, including non-latin scripts and emoji, untouched', () => {
    const s = 'Résumé — 日本語 — مرحبا — 🚀';
    expect(visibleText(s)).toBe(s);
  });

  it('shows newlines and tabs in a one-line value, and keeps them as layout in a multiline one', () => {
    expect(visibleText('a\nb\tc\r')).toBe('a⟨U+000A⟩b⟨U+0009⟩c⟨U+000D⟩');
    expect(visibleText('a\nb\tc', { multiline: true })).toBe('a\nb\tc');
    // A carriage return and a bidi override are never layout.
    expect(visibleText('a\r\u202eb', { multiline: true })).toBe('a⟨U+000D⟩⟨U+202E⟩b');
  });

  it('shows every occurrence, so a reordered line cannot hide behind the first', () => {
    expect(visibleText('\u202eadmin\u202c\u200b')).toBe('⟨U+202E⟩admin⟨U+202C⟩⟨U+200B⟩');
  });

  it('is null-tolerant for optional fields', () => {
    expect(visibleOrNull(null)).toBeNull();
    expect(visibleOrNull(undefined)).toBeNull();
    expect(visibleOrNull('x\u200b')).toBe('x⟨U+200B⟩');
  });
});
