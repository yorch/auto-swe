// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import {
  useAddTeamMember,
  useAdminTeamIds,
  useLedTeamIds,
  useRemoveTeamMember,
  useUpdateTeamMember,
} from './useTeams';

const get = vi.fn();
const write = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    delete: (...a: unknown[]) => write(...a),
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => write(...a),
    post: (...a: unknown[]) => write(...a),
  },
}));

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const team = (id: string, myRole: 'ADMIN' | 'LEAD' | 'ENGINEER' | null) => ({
  _count: { memberships: 1, repositories: 0 },
  defaultPersonaPrompt: null,
  description: '',
  id,
  myRole,
  name: id,
  orgId: 'o1',
  orgName: 'Org',
  slug: id,
});

function signIn(role: 'ADMIN' | 'LEAD' | 'ENGINEER') {
  useAuthStore.setState({ user: { role, sub: 'u1' } } as never);
}

beforeEach(() => {
  get.mockReset();
  write.mockReset();
  write.mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  get.mockResolvedValue({
    data: [team('a', 'ADMIN'), team('l', 'LEAD'), team('e', 'ENGINEER'), team('n', null)],
  });
});

describe('team id hooks derived from myRole', () => {
  it('counts LEAD and ADMIN memberships as led, never a null role', async () => {
    signIn('LEAD');
    const { result } = renderHook(() => useLedTeamIds(), { wrapper });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect([...(result.current ?? [])].sort()).toEqual(['a', 'l']);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/api/v1/teams?member=true');
  });

  it('counts only ADMIN memberships as admin', async () => {
    signIn('LEAD');
    const { result } = renderHook(() => useAdminTeamIds(), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect([...(result.current ?? [])]).toEqual(['a']);
  });

  it('does not load the list for a platform ADMIN, who bypasses team checks', () => {
    signIn('ADMIN');
    const { result } = renderHook(() => useLedTeamIds(), { wrapper });
    expect(result.current).toEqual(new Set());
    expect(get).not.toHaveBeenCalled();
  });

  it('loads the list for a platform ENGINEER, because the team role alone decides', async () => {
    signIn('ENGINEER');
    const { result } = renderHook(() => useLedTeamIds(), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect([...(result.current ?? [])].sort()).toEqual(['a', 'l']);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('membership mutations refresh the led/admin sets', () => {
  const cases = [
    [
      'add',
      () => useAddTeamMember('l'),
      (m: { mutate: (v: never) => void }) => m.mutate({ userId: 'u2' } as never),
    ],
    [
      'update',
      () => useUpdateTeamMember('l'),
      (m: { mutate: (v: never) => void }) => m.mutate({ role: 'ENGINEER', userId: 'u1' } as never),
    ],
    [
      'remove',
      () => useRemoveTeamMember('l'),
      (m: { mutate: (v: never) => void }) => m.mutate('u1' as never),
    ],
  ] as const;

  it.each(cases)('after %s the led set is refetched', async (_name, useMutationHook, run) => {
    signIn('LEAD');
    const led = renderHook(() => useLedTeamIds(), { wrapper });
    await waitFor(() => expect(led.result.current).not.toBeNull());
    expect([...(led.result.current ?? [])].sort()).toEqual(['a', 'l']);
    // The caller was demoted in team `l`: the next list no longer counts it as led.
    get.mockResolvedValue({ data: [team('a', 'ADMIN'), team('l', 'ENGINEER')] });
    const mutation = renderHook(() => useMutationHook(), { wrapper });
    act(() => run(mutation.result.current as never));
    await waitFor(() => expect([...(led.result.current ?? [])]).toEqual(['a']));
  });
});
