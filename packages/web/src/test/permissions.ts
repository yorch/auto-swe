// Test double for the server's effective permissions (`GET /api/v1/me/permissions`).
//
// A component test does not stub `useCan`: it states what the server says the person holds, and
// the real `useCan` decides from that, so the decision logic is exercised too. Mock the data hook
// in the test file, then set the answer in `beforeEach`:
//
//   vi.mock('@/hooks/useEffectivePermissions', async () =>
//     (await import('@/test/permissions')).permissionsMock());
//   beforeEach(() => setPermissions(ADMIN_PERMISSIONS));

import type { CapabilityKey } from '@auto-swe/shared/permissions';
import type { Permissions } from '@/lib/capabilities';

export interface TeamStanding {
  teamId: string;
  orgId?: string | null;
  /** The stored team role; null (the default) for capabilities held only through authority. */
  role?: string | null;
  authority?: 'team-role' | 'org-admin' | 'platform-admin' | 'org-member';
  capabilities: CapabilityKey[];
}

export interface OrgStanding {
  orgId: string;
  role?: string;
  capabilities: CapabilityKey[];
}

/** An answer, built from plain lists of keys. */
export function permissionsFor(
  opts: {
    platform?: CapabilityKey[];
    teams?: TeamStanding[];
    orgs?: OrgStanding[];
    platformRole?: string;
  } = {}
): Permissions {
  return {
    organizations: (opts.orgs ?? []).map((o) => ({
      capabilities: o.capabilities.map((key) => ({ authority: 'org-admin', key })),
      name: o.orgId,
      orgId: o.orgId,
      role: o.role ?? '',
    })),
    platformCapabilities: opts.platform ?? [],
    platformRole: opts.platformRole ?? '',
    teams: (opts.teams ?? []).map((t) => ({
      capabilities: t.capabilities.map((key) => ({ authority: t.authority ?? 'team-role', key })),
      name: t.teamId,
      orgId: t.orgId ?? null,
      role: t.role ?? null,
      slug: t.teamId,
      teamId: t.teamId,
    })),
  } as Permissions;
}

/** A platform administrator: every platform capability the dashboard asks about is held. */
export const ADMIN_PERMISSIONS: Permissions = permissionsFor({
  platform: ['platform.users.manage'],
});

/** A person with no standing anywhere. */
export const NO_PERMISSIONS: Permissions = permissionsFor();

let current: Permissions | undefined;
const narrowed = new Map<string, Permissions>();

/** What the mocked hook answers; `undefined` is "not loaded yet". */
export function setPermissions(perms: Permissions | undefined): void {
  current = perms;
}

/** The answer of `?teamId=<id>`: capabilities held on a team the person is not a member of. */
export function setNarrowedPermissions(teamId: string, perms: Permissions): void {
  narrowed.set(teamId, perms);
}

export function resetPermissions(): void {
  current = undefined;
  narrowed.clear();
}

/** The module replacement for `@/hooks/useEffectivePermissions`. */
export function permissionsMock() {
  return {
    PERMISSIONS_KEY: ['me', 'permissions'] as const,
    teamPermissionsQuery: (sub: string | null, teamId: string | null | undefined) => ({
      enabled: false,
      queryFn: async () => {
        throw new Error('no per-team permissions in this test');
      },
      queryKey: ['me', 'permissions', sub, 'team', teamId ?? null],
      retry: false,
    }),
    useEffectivePermissions: () => ({ data: current, isLoading: false }),
    useTeamPermissions: (teamId: string | null | undefined) => ({
      data: teamId ? narrowed.get(teamId) : undefined,
    }),
  };
}
