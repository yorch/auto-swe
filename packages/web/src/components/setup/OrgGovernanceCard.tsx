'use client';

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { useOrgIdsCan, usePlatformAdmin } from '@/hooks/useCan';
import { useEffectivePermissions } from '@/hooks/useEffectivePermissions';
import { cn, FOCUS_RING } from '@/lib/utils';

/** An organization the person administers, with the capabilities that decide which links show. */
export interface AdministeredOrg {
  orgId: string;
  name: string;
  canManageMembers: boolean;
}

/**
 * Whether Home is a governance view for this person: they administer at least one organization
 * and belong to no team, so the first-run steps and the Start work prompts do not apply to them
 * yet. `null` while the answer loads. A platform administrator is never governance-only: their
 * setup card and governance guide are their Home.
 *
 * "Administers" is the organization-settings capability, which only an organization admin holds
 * (the server decides; no role is read here).
 */
export function useOrgGovernance(): { orgs: AdministeredOrg[] } | null {
  const { data: perms } = useEffectivePermissions();
  const platformAdmin = usePlatformAdmin();
  const administered = useOrgIdsCan('org.settings.manage');
  const managesMembers = useOrgIdsCan('org.members.manage');
  if (!perms || administered === null || managesMembers === null) {
    return null;
  }
  const orgs = (perms.organizations ?? [])
    .filter((o) => administered.has(o.orgId))
    .map((o) => ({
      canManageMembers: managesMembers.has(o.orgId),
      name: o.name,
      orgId: o.orgId,
    }));
  if (platformAdmin || orgs.length === 0 || (perms.teams ?? []).length > 0) {
    return { orgs: [] };
  }
  return { orgs };
}

const LINK = cn(
  'inline-flex items-center rounded-sm text-sm text-accent-400 underline-offset-2 hover:underline',
  FOCUS_RING
);

/** Home's card for someone who administers an organization and has no team of their own. */
export function OrgGovernanceCard({ orgs }: { orgs: AdministeredOrg[] }) {
  if (orgs.length === 0) {
    return null;
  }
  const names = orgs.map((o) => o.name).join(', ');
  return (
    <Card data-testid="org-governance-card">
      <h2 className="text-lg font-semibold tracking-tight text-paper-50">You administer {names}</h2>
      <p className="mt-1 text-sm text-paper-400">
        Teams, budgets, repositories. To run work, add yourself to a team.
      </p>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
        <li>
          <Link className={LINK} href="/teams">
            Teams
          </Link>
        </li>
        {orgs
          .filter((o) => o.canManageMembers)
          .map((o) => (
            <li key={o.orgId}>
              <Link className={LINK} href={`/admin/organizations/${o.orgId}`}>
                {orgs.length > 1 ? `Manage ${o.name}` : 'Manage organization'}
              </Link>
            </li>
          ))}
      </ul>
    </Card>
  );
}
