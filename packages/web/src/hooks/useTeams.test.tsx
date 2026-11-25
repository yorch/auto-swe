// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { useCan } from './useCan';
import { ME_SUMMARY_KEY } from './useMeSummary';
import {
  useAddTeamMember,
  useAuthoringTeams,
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

const team = (id: string, myRole: 'ADMIN' | 'LEAD' | 'MEMBER' | null) => ({
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

const standing = (teamId: string, role: string, keys: string[]) => ({
  capabilities: keys.map((key) => ({ authority: 'team-role', key })),
  name: teamId,
  orgId: 'o1',
  role,
  slug: teamId,
  teamId,
});

const answer = (teams: ReturnType<typeof standing>[], admin = false) => ({
  organizations: [],
  platformCapabilities: admin ? ['platform.users.manage'] : [],
  platformRole: admin ? 'ADMIN' : 'USER',
  teams,
});

/** The server's two answers: the team list, and what the person holds. */
let permissions: ReturnType<typeof answer>;
function serve() {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/v1/me/permissions')) {
      return permissions;
    }
    return {
      data: [team('a', 'ADMIN'), team('l', 'LEAD'), team('m', 'MEMBER'), team('n', null)],
    };
  });
}

beforeEach(() => {
  get.mockReset();
  write.mockReset();
  write.mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useAuthStore.setState({ user: { role: 'USER', sub: 'u1' } } as never);
  permissions = answer([
    standing('a', 'ADMIN', ['team.templates.write']),
    standing('l', 'LEAD', ['team.templates.write']),
    standing('m', 'MEMBER', []),
  ]);
  serve();
});

describe('useAuthoringTeams', () => {
  it('lists the member teams on which the server says the caller may write templates', async () => {
    const { result } = renderHook(() => useAuthoringTeams(), { wrapper });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.teams.length).toBeGreaterThan(0));
    expect(result.current.teams.map((t) => t.id).sort()).toEqual(['a', 'l']);
    expect(result.current.global).toBe(false);
    expect(get).toHaveBeenCalledWith('/api/v1/teams?member=true');
  });

  it('lists nothing for a person with no capability on any team', async () => {
    permissions = answer([standing('m', 'MEMBER', [])]);
    const { result } = renderHook(() => useAuthoringTeams(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.teams).toEqual([]);
  });

  it('gives a platform admin every team and the global scope', async () => {
    permissions = answer([], true);
    const { result } = renderHook(() => useAuthoringTeams(), { wrapper });
    await waitFor(() => expect(result.current.global).toBe(true));
    await waitFor(() => expect(result.current.teams.length).toBe(4));
    expect(get).toHaveBeenCalledWith('/api/v1/teams');
    expect(get).not.toHaveBeenCalledWith('/api/v1/teams?member=true');
  });

  it('asks for nothing while no user is signed in', () => {
    useAuthStore.setState({ user: null } as never);
    const { result } = renderHook(() => useAuthoringTeams(), { wrapper });
    expect(result.current.teams).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('membership mutations refresh the effective permissions', () => {
  const cases = [
    [
      'add',
      () => useAddTeamMember('l'),
      (m: { mutate: (v: never) => void }) => m.mutate({ userId: 'u2' } as never),
    ],
    [
      'update',
      () => useUpdateTeamMember('l'),
      (m: { mutate: (v: never) => void }) => m.mutate({ role: 'MEMBER', userId: 'u1' } as never),
    ],
    [
      'remove',
      () => useRemoveTeamMember('l'),
      (m: { mutate: (v: never) => void }) => m.mutate('u1' as never),
    ],
  ] as const;

  it.each(cases)(
    'after %s what the caller may do is read again',
    async (_name, useMutationHook, run) => {
      const can = renderHook(() => useCan('team.templates.write', { teamId: 'l' }), { wrapper });
      await waitFor(() => expect(can.result.current).toBe(true));
      // The caller was demoted in team `l`: the next answer no longer lists the capability.
      permissions = answer([standing('l', 'MEMBER', [])]);
      const mutation = renderHook(() => useMutationHook(), { wrapper });
      act(() => run(mutation.result.current as never));
      await waitFor(() => expect(can.result.current).toBe(false));
    }
  );
});

describe('membership mutations refresh the team overview and the summary', () => {
  it.each([
    ['add', () => useAddTeamMember('l'), { userId: 'u2' }],
    ['update', () => useUpdateTeamMember('l'), { role: 'MEMBER', userId: 'u1' }],
    ['remove', () => useRemoveTeamMember('l'), 'u1'],
  ] as const)('after %s', async (_name, useMutationHook, variables) => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    const mutation = renderHook(() => useMutationHook(), { wrapper });
    act(() => (mutation.result.current as { mutate: (v: unknown) => void }).mutate(variables));
    await waitFor(() => {
      const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
      expect(keys).toContain(JSON.stringify(['team-overview', 'l']));
      expect(keys).toContain(JSON.stringify(ME_SUMMARY_KEY));
    });
  });
});
