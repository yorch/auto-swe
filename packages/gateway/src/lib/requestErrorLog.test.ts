import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { logRequestError } from './requestErrorLog.js';

function fakes(headers: Record<string, string> = {}, requestHeaders: Record<string, string> = {}) {
  const log = { error: vi.fn(), warn: vi.fn() };
  const request = {
    headers: requestHeaders,
    ip: '203.0.113.9',
    log,
    routeOptions: { url: '/api/v1/things' },
    server: { auth: { verifyAccessTokenClaims: () => ({ sub: 'user-1' }) } },
  } as unknown as FastifyRequest;
  const reply = {
    getHeader: (name: string) => headers[name],
  } as unknown as FastifyReply;
  return { log, reply, request };
}

describe('logRequestError', () => {
  it('logs a rate-limit refusal as one WARN line without the error or its stack', () => {
    const { log, reply, request } = fakes({ 'x-ratelimit-limit': '200' });
    const error = Object.assign(new Error('Rate limit exceeded, retry in 1 minute'), {
      statusCode: 429,
    }) as FastifyError;

    logRequestError(request, reply, error);

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const args = log.warn.mock.calls[0] as unknown[];
    expect(args).toHaveLength(1);
    expect(args[0]).toBe('rate limit exceeded: route=/api/v1/things key=ip limit=200');
  });

  it('falls back to the path, never the query string, when no route matched', () => {
    const { log, reply, request } = fakes({ 'x-ratelimit-limit': '200' });
    Object.assign(request, { routeOptions: {}, url: '/nope?token=secret' });
    const error = Object.assign(new Error('Rate limit exceeded'), {
      statusCode: 429,
    }) as FastifyError;

    logRequestError(request, reply, error);

    expect(log.warn).toHaveBeenCalledWith('rate limit exceeded: route=/nope key=ip limit=200');
  });

  it('names the key kind a verified caller was limited by', () => {
    const { log, reply, request } = fakes(
      { 'x-ratelimit-limit': '200' },
      { authorization: 'Bearer a.valid.jwt' }
    );
    const error = Object.assign(new Error('Rate limit exceeded'), {
      statusCode: 429,
    }) as FastifyError;

    logRequestError(request, reply, error);

    expect(log.warn).toHaveBeenCalledWith(
      'rate limit exceeded: route=/api/v1/things key=user limit=200'
    );
  });

  it('keeps logging other errors at ERROR with the error itself', () => {
    const { log, reply, request } = fakes();
    const error = Object.assign(new Error('boom'), { statusCode: 500 }) as FastifyError;

    logRequestError(request, reply, error);

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(error);
  });

  it('keeps logging other 4xx errors at ERROR', () => {
    const { log, reply, request } = fakes();
    const error = Object.assign(new Error('nope'), { statusCode: 400 }) as FastifyError;

    logRequestError(request, reply, error);

    expect(log.error).toHaveBeenCalledWith(error);
  });
});
