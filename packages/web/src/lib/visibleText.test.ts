import { describe, expect, it } from 'vitest';
import { visibleOrNull, visibleText } from './visibleText';

const CLASSES: Array<[string, number]> = [
  ['Cc control', 0x1b],
  ['C1 control', 0x85],
  ['soft hyphen', 0xad],
  ['combining grapheme joiner', 0x34f],
  ['Arabic letter mark', 0x61c],
  ['Hangul choseong filler', 0x115f],
  ['Hangul jungseong filler', 0x1160],
  ['Khmer inherent vowel', 0x17b4],
  ['Mongolian free variation selector', 0x180b],
  ['Mongolian vowel separator', 0x180e],
  ['zero-width space', 0x200b],
  ['left-to-right mark', 0x200e],
  ['line separator', 0x2028],
  ['paragraph separator', 0x2029],
  ['bidi override', 0x202e],
  ['word joiner', 0x2060],
  ['invisible times', 0x2062],
  ['bidi isolate', 0x2067],
  ['deprecated format character', 0x206a],
  ['deprecated format character (last)', 0x206f],
  ['ideographic Hangul filler', 0x3164],
  ['variation selector', 0xfe0f],
  ['byte order mark', 0xfeff],
  ['halfwidth Hangul filler', 0xffa0],
  ['interlinear annotation anchor', 0xfff9],
  ['interlinear annotation terminator', 0xfffb],
  ['variation selector supplement', 0xe0100],
  ['tag space', 0xe0020],
  ['tag latin letter a', 0xe0041],
  ['tag cancel', 0xe007f],
];

describe('visibleText hidden-character classes', () => {
  it.each(CLASSES)('shows %s', (_name, cp) => {
    const shown = `⟨U+${cp.toString(16).toUpperCase().padStart(4, '0')}⟩`;
    expect(visibleText(`a${String.fromCodePoint(cp)}b`)).toBe(`a${shown}b`);
    expect(visibleText(`a${String.fromCodePoint(cp)}b`, { multiline: true })).toBe(`a${shown}b`);
  });

  it('shows a smuggled tag-character instruction, one marker per code point', () => {
    const hidden = [...'ignore']
      .map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0)))
      .join('');
    const out = visibleText(`fine${hidden}`);
    expect(out.startsWith('fine⟨U+E0069⟩⟨U+E0067⟩')).toBe(true);
    expect(out.match(/⟨/g)).toHaveLength(6);
  });

  it('keeps ordinary visible text: emoji, ZWJ-free scripts, accents, and a plain space', () => {
    expect(visibleText('café 日本 ا 😀 x y')).toBe('café 日本 ا 😀 x y');
  });
});

describe('visibleText emoji sequences', () => {
  const ZWJ = '\u200d';
  const VS16 = '\ufe0f';
  it.each([
    ['warning sign with emoji presentation', `\u26a0${VS16} careful`],
    ['text presentation selector', 'sun \u2600\ufe0e'],
    ['keycap', `1${VS16}\u20e3`],
    ['ZWJ family', `\u{1f469}${ZWJ}\u{1f469}${ZWJ}\u{1f467}`],
    ['ZWJ sequence through a variation selector', `\u{1f469}${ZWJ}\u2764${VS16}${ZWJ}\u{1f469}`],
  ])('leaves %s unmarked', (_n, text) => {
    expect(visibleText(text)).toBe(text);
    expect(visibleText(text, { multiline: true })).toBe(text);
  });

  it.each([
    ['a selector after a non-emoji', 'a\ufe0f', 'a⟨U+FE0F⟩'],
    ['a selector at the start', '\ufe0f', '⟨U+FE0F⟩'],
    ['a doubled selector', `\u26a0${VS16}${VS16}`, `\u26a0${VS16}⟨U+FE0F⟩`],
    ['a joiner between letters', `a${ZWJ}b`, 'a⟨U+200D⟩b'],
    ['a joiner after an emoji and before a letter', `\u{1f469}${ZWJ}b`, '\u{1f469}⟨U+200D⟩b'],
    ['a leading joiner', `${ZWJ}\u{1f469}`, '⟨U+200D⟩\u{1f469}'],
    ['a trailing joiner', `\u{1f469}${ZWJ}`, '\u{1f469}⟨U+200D⟩'],
    ['a tag character inside an emoji', `\u{1f3f4}\u{e0067}`, '\u{1f3f4}⟨U+E0067⟩'],
  ])('still marks %s', (_n, text, shown) => {
    expect(visibleText(text)).toBe(shown);
  });
});

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
