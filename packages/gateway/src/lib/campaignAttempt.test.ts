import { describe, expect, it } from 'vitest';
import { isDefiniteNonStart } from './campaignAttempt.js';

const named = (name: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(name), { name, ...extra });
const grpc = (code: number) => named('ServiceError', { cause: { code } });

describe('isDefiniteNonStart', () => {
  it('is true when the client refused the call before any RPC, or the connection was refused', () => {
    expect(isDefiniteNonStart(named('ValueError'))).toBe(true);
    expect(isDefiniteNonStart(named('PayloadConverterError'))).toBe(true);
    expect(isDefiniteNonStart(new TypeError('x'))).toBe(true);
    expect(isDefiniteNonStart(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isDefiniteNonStart(named('ServiceError', { cause: { code: 'ECONNREFUSED' } }))).toBe(
      true
    );
  });

  it.each([
    [3, 'INVALID_ARGUMENT'],
    [5, 'NOT_FOUND'],
    [7, 'PERMISSION_DENIED'],
    [8, 'RESOURCE_EXHAUSTED'],
    [9, 'FAILED_PRECONDITION'],
    [12, 'UNIMPLEMENTED'],
    [16, 'UNAUTHENTICATED'],
  ])('is true for a server that rejected the request outright (%i %s)', (code) => {
    expect(isDefiniteNonStart(grpc(code))).toBe(true);
  });

  it.each([
    [1, 'CANCELLED'],
    [2, 'UNKNOWN'],
    [4, 'DEADLINE_EXCEEDED'],
    [13, 'INTERNAL'],
    [14, 'UNAVAILABLE'],
  ])('is false where the call may have reached the server (%i %s)', (code) => {
    expect(isDefiniteNonStart(grpc(code))).toBe(false);
  });

  it('is false for anything unrecognised, so an execution that may exist is never forgotten', () => {
    expect(isDefiniteNonStart(new Error('socket hang up'))).toBe(false);
    expect(isDefiniteNonStart(named('ServiceError'))).toBe(false);
    expect(isDefiniteNonStart('boom')).toBe(false);
    expect(isDefiniteNonStart(null)).toBe(false);
    expect(isDefiniteNonStart(undefined)).toBe(false);
  });
});
