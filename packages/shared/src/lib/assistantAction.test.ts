import { describe, expect, it } from 'vitest';
import { assistantActionDigest } from './assistantAction.js';

describe('assistantActionDigest', () => {
  const base = { body: { a: 1, b: { c: [1, 2] } }, method: 'POST', url: '/api/v1/work-requests' };

  it('ignores key order and the case of the method', () => {
    // Built from entries, because a formatter that sorts object keys would quietly undo the point.
    const reordered = Object.fromEntries([
      ['b', { c: [1, 2] }],
      ['a', 1],
    ]);
    expect(Object.keys(reordered)).toEqual(['b', 'a']);
    expect(assistantActionDigest({ body: reordered, method: 'post', url: base.url })).toBe(
      assistantActionDigest(base)
    );
  });

  it('changes with the body, the method, the path and the query', () => {
    const digest = assistantActionDigest(base);
    expect(assistantActionDigest({ ...base, body: { ...base.body, a: 2 } })).not.toBe(digest);
    expect(assistantActionDigest({ ...base, body: { a: 1, b: { c: [2, 1] } } })).not.toBe(digest);
    expect(assistantActionDigest({ ...base, method: 'PUT' })).not.toBe(digest);
    expect(assistantActionDigest({ ...base, url: '/api/v1/work-requests/x' })).not.toBe(digest);
    expect(assistantActionDigest({ ...base, url: `${base.url}?dryRun=1` })).not.toBe(digest);
  });

  it('reads a missing body as null, and nothing else as null', () => {
    const none = assistantActionDigest({ ...base, body: undefined });
    expect(assistantActionDigest({ ...base, body: null })).toBe(none);
    expect(assistantActionDigest({ ...base, body: {} })).not.toBe(none);
    expect(assistantActionDigest({ ...base, body: '' })).not.toBe(none);
  });

  it('survives the JSON round trip the worker and gateway put a body through', () => {
    const parsed = JSON.parse(JSON.stringify(base.body));
    expect(assistantActionDigest({ ...base, body: parsed })).toBe(assistantActionDigest(base));
  });
});
