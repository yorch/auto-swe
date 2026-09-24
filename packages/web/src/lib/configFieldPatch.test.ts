import { describe, expect, it } from 'vitest';
import { clearableField, clearableIntField } from './configFieldPatch';

describe('clearableField', () => {
  it('omits an unchanged value', () => {
    expect(clearableField('https://ghe.example', 'https://ghe.example')).toBeUndefined();
    expect(clearableField('', null)).toBeUndefined();
    expect(clearableField('  ', undefined)).toBeUndefined();
  });
  it('sends null when a stored value is cleared', () => {
    expect(clearableField('', 'https://ghe.example')).toBeNull();
    expect(clearableField('   ', 'x')).toBeNull();
  });
  it('sends the trimmed new value', () => {
    expect(clearableField(' https://b ', 'https://a')).toBe('https://b');
    expect(clearableField('x', null)).toBe('x');
  });
});

describe('clearableIntField', () => {
  it('omits unchanged or unparseable input', () => {
    expect(clearableIntField('10', 10)).toBeUndefined();
    expect(clearableIntField('', null)).toBeUndefined();
    expect(clearableIntField('abc', 5)).toBeUndefined();
  });
  it('clears and sets', () => {
    expect(clearableIntField('', 10)).toBeNull();
    expect(clearableIntField('12', 10)).toBe(12);
  });
});
