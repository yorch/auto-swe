import { describe, expect, it } from 'vitest';
import { isProxyTokenPath } from './tracePolicy.js';

describe('isProxyTokenPath', () => {
  it.each([
    '/go/tok/go-1/a/@v/list',
    '/pypi/tok/py-1/simple/flask/',
    '/./pypi/tok/py-1/simple/flask/',
    '/%2e/pypi/tok/py-1/simple/flask/',
    '/%2E/go/tok/go-1/a/@latest',
    '/x/../pypi/tok/py-1/simple/flask/',
    '/x/%2e%2e/go/tok/go-1/a/@latest',
    'http://proxy/pypi/tok/py-1/simple/flask/',
    'http://example.test:8080/go/tok/go-1/a/@latest',
    '//host/pypi/tok/x',
    'http://[::1',
  ])('does not trace %s', (target) => {
    expect(isProxyTokenPath(target)).toBe(true);
  });

  it.each([undefined, '/', '/health', '/npm/tok/npm-1/pkg', '/gopher/x', '/pypi', '/api/v1/go/x'])(
    'traces %s',
    (target) => {
      expect(isProxyTokenPath(target)).toBe(false);
    }
  );
});
