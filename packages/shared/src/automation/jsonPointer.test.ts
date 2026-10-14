import { describe, expect, it } from 'vitest';
import {
  formatJsonPointer,
  isJsonPointer,
  parseJsonPointer,
  resolveJsonPointer,
} from './jsonPointer.js';

// The example document of RFC 6901 §5.
const DOC = {
  '': 0,
  ' ': 7,
  'a/b': 1,
  'c%d': 2,
  'e^f': 3,
  foo: ['bar', 'baz'],
  'g|h': 4,
  'i\\j': 5,
  'k"l': 6,
  'm~n': 8,
};

describe('JSON Pointer (RFC 6901)', () => {
  it('resolves every example of the RFC', () => {
    const cases: [string, unknown][] = [
      ['', DOC],
      ['/foo', ['bar', 'baz']],
      ['/foo/0', 'bar'],
      ['/', 0],
      ['/a~1b', 1],
      ['/c%d', 2],
      ['/e^f', 3],
      ['/g|h', 4],
      ['/i\\j', 5],
      ['/k"l', 6],
      ['/ ', 7],
      ['/m~0n', 8],
    ];
    for (const [pointer, value] of cases) {
      expect(resolveJsonPointer(DOC, pointer)).toEqual({ found: true, value });
    }
  });

  it('unescapes ~1 before ~0, so ~01 is the text ~1', () => {
    expect(parseJsonPointer('/~01')).toEqual(['~1']);
    expect(resolveJsonPointer({ '/': 'no', '~1': 'yes' }, '/~01')).toEqual({
      found: true,
      value: 'yes',
    });
    expect(formatJsonPointer(['a/b', 'm~n'])).toBe('/a~1b/m~0n');
  });

  it('refuses what is not a pointer', () => {
    for (const bad of ['foo', '/~2', '/a~', `/${'a'.repeat(300)}`, `${'/a'.repeat(40)}`]) {
      expect(isJsonPointer(bad)).toBe(false);
      expect(resolveJsonPointer(DOC, bad)).toEqual({ found: false });
    }
  });

  it('addresses arrays by decimal index only', () => {
    const doc = { list: ['a', 'b', { deep: [true] }] };
    expect(resolveJsonPointer(doc, '/list/2/deep/0')).toEqual({ found: true, value: true });
    for (const miss of ['/list/3', '/list/-', '/list/01', '/list/-1', '/list/1e0', '/list/ 1']) {
      expect(resolveJsonPointer(doc, miss)).toEqual({ found: false });
    }
  });

  it('reports missing keys, steps into scalars and inherited properties as not found', () => {
    const doc = { a: { b: null }, s: 'text' };
    expect(resolveJsonPointer(doc, '/a/b')).toEqual({ found: true, value: null });
    expect(resolveJsonPointer(doc, '/a/c')).toEqual({ found: false });
    expect(resolveJsonPointer(doc, '/s/0')).toEqual({ found: false });
    expect(resolveJsonPointer(doc, '/s/length')).toEqual({ found: false });
    expect(resolveJsonPointer(doc, '/constructor')).toEqual({ found: false });
    expect(resolveJsonPointer(doc, '/__proto__')).toEqual({ found: false });
    expect(resolveJsonPointer(['x'], '/length')).toEqual({ found: false });
  });
});
