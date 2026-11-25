// @vitest-environment jsdom
import type { EffectivePermissions } from '@auto-swe/shared/permissions';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import {
  useCan,
  useCanOnTeams,
  useCanOwned,
  useCanState,
  useGrantableTeamRoles,
  usePlatformAdmin,
  useTeamIdsCan,
} from './useCan';

const get = vi.fn();
vi.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a) } }));

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const held = (...keys: string[]) =>
  keys.map((key) => ({ authority: 'team-role' as const, key })) as never;

function answer(partial: Partial<EffectivePermissions> = {}): EffectivePermissions {
  return {
    organizations: [],
    platformCapabilities: [],
    platformRole: 'USER',
    teams: [],
    ...partial,
  } as EffectivePermissions;
}

const ADMIN_ANSWER = answer({
  platformCapabilities: ['platform.users.manage', 'platform.audit.read'] as never,
  platformRole: 'ADMIN',
});

const MEMBER_ANSWER = answer({
  organizations: [{ capabilities: [], name: 'Acme', orgId: 'org-1', role: 'MEMBER' }] as never,
  teams: [
    {
      capabilities: held('team.read', 'team.members.manage', 'team.repos.manage'),
      name: 'Pay',
      orgId: 'org-1',
      role: 'LEAD',
      slug: 'pay',
      teamId: 't-lead',
    },
    {
      capabilities: held('team.read'),
      name: 'Ops',
      orgId: 'org-1',
      role: 'MEMBER',
      slug: 'ops',
      teamId: 't-member',
    },
  ] as never,
});

/** The answer for `?teamId=t-org`: capabilities held only through org authority. */
const NARROWED_ORG_ADMIN = answer({
  organizations: [
    { capabilities: held('org.budget.manage'), name: 'Acme', orgId: 'org-1', role: 'ADMIN' },
  ] as never,
  teams: [
    {
      capabilities: [
        { authority: 'org-admin', key: 'team.repos.manage' },
        { authority: 'org-admin', key: 'team.members.manage' },
      ],
      name: 'Org team',
      orgId: 'org-1',
      role: null,
      slug: 'org-team',
      teamId: 't-org',
    },
  ] as never,
});

const ORG_ADMIN_ANSWER = answer({
  organizations: [
    {
      capabilities: held('org.budget.manage', 'org.members.manage'),
      name: 'Acme',
      orgId: 'org-1',
      role: 'ADMIN',
    },
  ] as never,
});

function respond(base: EffectivePermissions, narrowed?: EffectivePermissions) {
  get.mockImplementation(async (url: string) => {
    if (url.includes('?teamId=')) {
      if (!narrowed) {
        throw new Error('403');
      }
      return narrowed;
    }
    return base;
  });
}

beforeEach(() => {
  get.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useAuthStore.setState({
    isAuthenticated: true,
    user: { role: 'USER', sub: 'u-1' },
  } as never);
});

describe('useCan', () => {
  it('is false while the permissions load, and never grants before they answer', async () => {
    respond(ADMIN_ANSWER);
    const { result } = renderHook(() => useCan('platform.users.manage'), { wrapper });
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('is false without a session, and sends no request', () => {
    useAuthStore.setState({ isAuthenticated: false, user: null } as never);
    respond(ADMIN_ANSWER);
    const { result } = renderHook(() => useCan('platform.users.manage'), { wrapper });
    expect(result.current).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it('holds everything for a platform administrator, on any team', async () => {
    respond(ADMIN_ANSWER);
    const { result } = renderHook(
      () => ({
        any: useCan('team.secrets.manage'),
        org: useCan('org.budget.manage', { orgId: 'o-x' }),
        platform: useCan('platform.scanner.manage'),
        team: useCan('team.secrets.manage', { teamId: 't-anything' }),
      }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.platform).toBe(true));
    expect(result.current).toEqual({ any: true, org: true, platform: true, team: true });
    // An administrator needs no per-team request.
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('reads a member team from its entry', async () => {
    respond(MEMBER_ANSWER);
    const { result } = renderHook(
      () => ({
        leadManages: useCan('team.members.manage', { teamId: 't-lead' }),
        memberManages: useCan('team.members.manage', { teamId: 't-member' }),
        platform: useCan('platform.users.manage'),
      }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.leadManages).toBe(true));
    expect(result.current.memberManages).toBe(false);
    expect(result.current.platform).toBe(false);
  });

  it('answers "on any team" for a team capability without an id', async () => {
    respond(MEMBER_ANSWER);
    const { result } = renderHook(
      () => ({ held: useCan('team.repos.manage'), notHeld: useCan('team.secrets.manage') }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.held).toBe(true));
    expect(result.current.notHeld).toBe(false);
  });

  it('falls back to a per-team request for a team the person is not a member of', async () => {
    respond(MEMBER_ANSWER, NARROWED_ORG_ADMIN);
    const { result } = renderHook(
      () => useCan('team.repos.manage', { orgId: 'org-1', teamId: 't-org' }),
      { wrapper }
    );
    await waitFor(() => expect(result.current).toBe(true));
    expect(get).toHaveBeenCalledWith('/api/v1/me/permissions?teamId=t-org');
  });

  it('keys the per-team fallback by team, so another team is asked separately', async () => {
    respond(MEMBER_ANSWER, NARROWED_ORG_ADMIN);
    const { result } = renderHook(
      () => ({
        a: useCan('team.repos.manage', { orgId: 'org-1', teamId: 't-org' }),
        b: useCan('team.repos.manage', { orgId: 'org-1', teamId: 't-other' }),
      }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.a).toBe(true));
    // The narrowed answer describes `t-org` only, so it says nothing about `t-other`.
    expect(result.current.b).toBe(false);
    const urls = get.mock.calls.map((c) => c[0]);
    expect(urls).toContain('/api/v1/me/permissions?teamId=t-other');
  });

  it('does not ask for a team of an organization the person is not in', async () => {
    respond(MEMBER_ANSWER, NARROWED_ORG_ADMIN);
    const { result } = renderHook(
      () => useCan('team.repos.manage', { orgId: 'org-elsewhere', teamId: 't-org' }),
      { wrapper }
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(result.current).toBe(false);
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining('?teamId='));
  });

  it('does not ask per team for a capability an organization role cannot confer', async () => {
    respond(MEMBER_ANSWER, NARROWED_ORG_ADMIN);
    const { result } = renderHook(
      () => useCan('team.secrets.manage', { orgId: 'org-1', teamId: 't-org' }),
      { wrapper }
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(result.current).toBe(false);
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining('?teamId='));
  });

  it('is false when the per-team request is refused', async () => {
    respond(MEMBER_ANSWER);
    const { result } = renderHook(
      () => useCan('team.repos.manage', { orgId: 'org-1', teamId: 't-org' }),
      { wrapper }
    );
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/v1/me/permissions?teamId=t-org'));
    expect(result.current).toBe(false);
  });

  it('reads an organization capability from the organization entry', async () => {
    respond(ORG_ADMIN_ANSWER);
    const { result } = renderHook(
      () => ({
        anywhere: useCan('org.members.manage'),
        here: useCan('org.budget.manage', { orgId: 'org-1' }),
        other: useCan('org.budget.manage', { orgId: 'org-2' }),
        unheld: useCan('org.settings.manage', { orgId: 'org-1' }),
      }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.here).toBe(true));
    expect(result.current).toEqual({ anywhere: true, here: true, other: false, unheld: false });
  });

  it('is false for a key the server did not list', async () => {
    respond(MEMBER_ANSWER);
    const { result } = renderHook(() => useCan('not.a.capability' as never, { teamId: 't-lead' }), {
      wrapper,
    });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('keeps one signed-in person from reading the previous one’s answer', async () => {
    respond(ADMIN_ANSWER);
    const first = renderHook(() => usePlatformAdmin(), { wrapper });
    await waitFor(() => expect(first.result.current).toBe(true));
    first.unmount();
    useAuthStore.setState({ user: { role: 'USER', sub: 'u-2' } } as never);
    respond(MEMBER_ANSWER);
    const second = renderHook(() => usePlatformAdmin(), { wrapper });
    expect(second.result.current).toBe(false);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(second.result.current).toBe(false);
  });
});

describe('useCanState', () => {
  const scope = { orgId: 'org-1', teamId: 't-org' };

  it('is pending until the per-team answer lands, then allowed', async () => {
    respond(ORG_ADMIN_ANSWER, NARROWED_ORG_ADMIN);
    const { result } = renderHook(() => useCanState('team.members.manage', scope), { wrapper });
    expect(result.current.pending).toBe(true);
    expect(result.current.allowed).toBe(false);
    await waitFor(() => expect(result.current.allowed).toBe(true));
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('reads a refusal as not allowed with no error, and any other failure as an error', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.includes('?teamId=')) {
        throw Object.assign(new Error('refused'), { status: 403 });
      }
      return ORG_ADMIN_ANSWER;
    });
    const refused = renderHook(() => useCanState('team.members.manage', scope), { wrapper });
    await waitFor(() => expect(refused.result.current.pending).toBe(false));
    expect(refused.result.current).toMatchObject({ allowed: false, error: null });
    refused.unmount();

    client.clear();
    get.mockImplementation(async (url: string) => {
      if (url.includes('?teamId=')) {
        throw Object.assign(new Error('down'), { status: 500 });
      }
      return ORG_ADMIN_ANSWER;
    });
    const failed = renderHook(() => useCanState('team.members.manage', scope), { wrapper });
    await waitFor(() => expect(failed.result.current.error).toBeTruthy());
    expect(failed.result.current).toMatchObject({ allowed: false, pending: false });
  });

  it('is not pending for a member team, which needs no per-team request', async () => {
    respond(MEMBER_ANSWER);
    const { result } = renderHook(
      () => useCanState('team.members.manage', { orgId: 'org-1', teamId: 't-lead' }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.allowed).toBe(true));
    expect(result.current.pending).toBe(false);
  });
});

describe('usePlatformAdmin', () => {
  it('reads the server’s answer, not the role in the session', async () => {
    // The session says USER; the answer says the person holds platform capabilities.
    respond(ADMIN_ANSWER);
    const { result } = renderHook(() => usePlatformAdmin(), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('is false for a member', async () => {
    respond(MEMBER_ANSWER);
    const { result } = renderHook(() => usePlatformAdmin(), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });
});

describe('useCanOnTeams', () => {
  it('answers per team for a list, asking only about teams that might hold it via the org', async () => {
    respond(MEMBER_ANSWER, NARROWED_ORG_ADMIN);
    const teams = [
      { id: 't-lead', orgId: 'org-1' },
      { id: 't-member', orgId: 'org-1' },
      { id: 't-org', orgId: 'org-1' },
      { id: 't-foreign', orgId: 'org-9' },
    ];
    const { result } = renderHook(() => useCanOnTeams('team.repos.manage', teams), { wrapper });
    await waitFor(() => expect(result.current('t-org')).toBe(true));
    expect(result.current('t-lead')).toBe(true);
    expect(result.current('t-member')).toBe(false);
    expect(result.current('t-foreign')).toBe(false);
    expect(result.current(undefined)).toBe(false);
    expect(get).not.toHaveBeenCalledWith('/api/v1/me/permissions?teamId=t-foreign');
  });
});

describe('useCanOwned', () => {
  it('asks the team when there is one, and the platform when there is none', async () => {
    respond(MEMBER_ANSWER);
    const { result } = renderHook(
      () => ({
        global: useCanOwned('team.repos.manage', null),
        owned: useCanOwned('team.repos.manage', 't-lead'),
      }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.owned).toBe(true));
    expect(result.current.global).toBe(false);
  });

  it('lets a platform administrator write a GLOBAL resource', async () => {
    respond(ADMIN_ANSWER);
    const { result } = renderHook(() => useCanOwned('team.repos.manage', undefined), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
  });
});

describe('useTeamIdsCan', () => {
  it('is null while loading, then the member teams holding the capability', async () => {
    respond(MEMBER_ANSWER);
    const { result } = renderHook(() => useTeamIdsCan('team.members.manage'), { wrapper });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect([...(result.current ?? [])]).toEqual(['t-lead']);
  });
});

describe('useGrantableTeamRoles', () => {
  it('offers roles up to the caller’s own team role', async () => {
    respond(MEMBER_ANSWER);
    const { result } = renderHook(() => useGrantableTeamRoles('t-lead'), { wrapper });
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
    expect(result.current).toEqual(['MEMBER', 'LEAD']);
  });

  it('offers nothing without the capability to manage members', async () => {
    respond(MEMBER_ANSWER);
    const { result } = renderHook(() => useGrantableTeamRoles('t-member'), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it('offers every role to authority held through the organization', async () => {
    respond(ORG_ADMIN_ANSWER, NARROWED_ORG_ADMIN);
    const { result } = renderHook(() => useGrantableTeamRoles('t-org'), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(3));
    expect(result.current).toEqual(['MEMBER', 'LEAD', 'ADMIN']);
  });

  it('offers every role to a platform administrator', async () => {
    respond(ADMIN_ANSWER);
    const { result } = renderHook(() => useGrantableTeamRoles('t-any'), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(3));
  });
});
