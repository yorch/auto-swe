import { Prisma } from '@auto-swe/shared';
import { describe, expect, it } from 'vitest';
import { isRecordNotFoundError, isUniqueConstraintError } from './prismaErrors.js';

const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('x', { clientVersion: 'test', code });

describe('prisma error helpers', () => {
  it('recognise their own code, from the client or a plain coded error', () => {
    expect(isUniqueConstraintError(known('P2002'))).toBe(true);
    expect(isUniqueConstraintError(Object.assign(new Error('u'), { code: 'P2002' }))).toBe(true);
    expect(isRecordNotFoundError(known('P2025'))).toBe(true);
    expect(isRecordNotFoundError(Object.assign(new Error('n'), { code: 'P2025' }))).toBe(true);
  });

  it('reject another code and anything that is not an error object', () => {
    expect(isUniqueConstraintError(known('P2025'))).toBe(false);
    expect(isRecordNotFoundError(known('P2002'))).toBe(false);
    for (const value of [null, undefined, 'P2025', 2025]) {
      expect(isRecordNotFoundError(value)).toBe(false);
      expect(isUniqueConstraintError(value)).toBe(false);
    }
  });
});
