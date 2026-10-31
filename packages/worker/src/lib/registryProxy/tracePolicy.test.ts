import { describe, expect, it } from 'vitest';
import { isProxyTokenPath } from './tracePolicy.js';

describe('isProxyTokenPath', () => {
  // `/pypi/<id>/…` holds no secret (its token is a Basic password); it is kept out of tracing
  // only so the proxy's Go and PyPI routes are treated alike.
  it.each([
    '/go/tok/go-1/a/@v/list',
    '/pypi/py-1/simple/flask/',
    '/maven/mv-1/a/b/1.0/b-1.0.jar',
    '/x/%2e%2e/maven/mv-1/a/b/1.0/b-1.0.jar',
    '/./pypi/py-1/simple/flask/',
    '/%2e/pypi/py-1/simple/flask/',
    '/%2E/go/tok/go-1/a/@latest',
    '/x/../pypi/py-1/simple/flask/',
    '/x/%2e%2e/go/tok/go-1/a/@latest',
    'http://proxy/pypi/py-1/simple/flask/',
    'http://example.test:8080/go/tok/go-1/a/@latest',
    '//host/pypi/py-1/x',
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
