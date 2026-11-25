import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { refreshPermissionsOnRefusal } from './refusalRefresh';

const forbidden = new ApiError('Requires LEAD in this team', 403, 'FORBIDDEN');

function setup() {
  const invalidateQueries = vi.fn().mockResolvedValue(undefined);
  let t = 1_000_000;
  const handle = refreshPermissionsOnRefusal(
    () => ({ invalidateQueries }) as unknown as QueryClient,
    () => t
  );
  return { advance: (ms: number) => (t += ms), handle, invalidateQueries };
}

describe('refreshPermissionsOnRefusal', () => {
  it('invalidates the permissions key once for a burst of 403s', () => {
    const { handle, invalidateQueries, advance } = setup();
    handle(forbidden);
    handle(forbidden);
    handle(forbidden);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['me', 'permissions'] });
    advance(6_000);
    handle(forbidden);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });
  it('ignores other errors and non-FORBIDDEN 403s', () => {
    const { handle, invalidateQueries } = setup();
    handle(new Error('x'));
    handle(new ApiError('nope', 500, 'SERVER_ERROR'));
    handle(new ApiError('nope', 403, null));
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
  it('does not refetch because the permissions read itself was refused', () => {
    const { handle, invalidateQueries } = setup();
    handle(forbidden, { queryKey: ['me', 'permissions', 'u1'] } as never);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
