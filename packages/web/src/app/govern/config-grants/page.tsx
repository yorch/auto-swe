'use client';

import { useMemo, useState } from 'react';
import { EligibleUserSelect } from '@/components/EligibleUserSelect';
import { RelativeTime } from '@/components/govern/RelativeTime';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useOrganizationDirectory } from '@/hooks/useAdmin';
import {
  type ConfigGrant,
  useConfigGrantPreview,
  useConfigGrants,
  useCreateConfigGrant,
  useRevokeConfigGrant,
} from '@/hooks/useConfigSettings';
import { useTeams } from '@/hooks/useTeams';
import { useEligibleUsers } from '@/hooks/useUsers';
import { errMsg } from '@/lib/errors';
import { platformRoleLabel } from '@/lib/govLabels';
import { navLabel } from '@/lib/navigation';
import { cn, FOCUS_RING, plural } from '@/lib/utils';

type GrantScope = 'GLOBAL' | 'ORGANIZATION' | 'TEAM';
type GrantRole = 'ADMIN' | 'LEAD' | 'ENGINEER';

export default function GovernConfigGrantsPage() {
  const {
    data: grants,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useConfigGrants();
  const createGrant = useCreateConfigGrant();
  const revokeGrant = useRevokeConfigGrant();
  const [revokeTarget, setRevokeTarget] = useState<ConfigGrant | null>(null);

  const [pattern, setPattern] = useState('');
  const [scope, setScope] = useState<GrantScope>('GLOBAL');
  const [granteeType, setGranteeType] = useState<'role' | 'user'>('role');
  const [role, setRole] = useState<GrantRole>('LEAD');
  const [userId, setUserId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [orgId, setOrgId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const preview = useConfigGrantPreview(pattern);
  const eligibleUsers = useEligibleUsers([]);
  const { data: teams } = useTeams();
  const { data: orgs } = useOrganizationDirectory();

  const examplePatterns = useMemo(
    () => ['*', 'channel.*', 'workflow.runConcurrency', 'memory.*', 'workspace.*'],
    []
  );

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
    // Comboboxes cannot be natively `required`, so check the picks here.
    if (granteeType === 'user' && !userId) {
      setFormError('Pick the user this grant is for.');
      return;
    }
    if (scope === 'TEAM' && !teamId) {
      setFormError('Pick the team this grant is limited to.');
      return;
    }
    if (scope === 'ORGANIZATION' && !orgId) {
      setFormError('Pick the organization this grant is limited to.');
      return;
    }
    const body: Parameters<typeof createGrant.mutateAsync>[0] = {
      keyPattern: pattern,
      scope,
      ...(granteeType === 'role' ? { role } : { userId }),
      ...(scope === 'TEAM' ? { teamId } : {}),
      ...(scope === 'ORGANIZATION' ? { orgId } : {}),
    };
    try {
      await createGrant.mutateAsync(body);
      setFormSuccess(`Grant created for ${pattern}`);
      setPattern('');
      setUserId('');
      setTeamId('');
      setOrgId('');
    } catch (err) {
      setFormError(errMsg(err, 'grant creation failed'));
    }
  };

  // Awaited so ConfirmModal keeps the dialog open and shows a failed revoke.
  const confirmRevoke = async () => {
    if (revokeTarget) {
      await revokeGrant.mutateAsync(revokeTarget.id);
    }
  };

  const allGrants = grants ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="Delegate fine-grained permission to change platform settings. Grants are bounded to known keys or groups — they never grant generic IAM or the ability to mint further grants."
        title={navLabel('/govern/config-grants')}
      />

      <Card className="fade-up stagger-1">
        <CardHeader className="mb-1">
          <CardTitle>Create a grant</CardTitle>
        </CardHeader>
        <p className="mb-5 text-[13px] text-paper-400">
          Choose which settings, who may change them, and where. The preview shows exactly which
          keys the pattern covers.
        </p>
        {formError && <Alert className="mb-4">{formError}</Alert>}
        {formSuccess && (
          <Alert className="mb-4" variant="success">
            {formSuccess}
          </Alert>
        )}
        <form className="space-y-5" onSubmit={handleCreate}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Input
                className="font-mono"
                hint="* for everything, channel.* for a group, or an exact setting key"
                label="Key pattern"
                onChange={(e) => setPattern(e.target.value)}
                placeholder="e.g. channel.*"
                required
                value={pattern}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-paper-500">Examples:</span>
                {examplePatterns.map((p) => (
                  <button
                    aria-pressed={pattern === p}
                    className={cn(
                      'rounded-md border px-1.5 py-0.5 font-mono text-xs transition-colors',
                      pattern === p
                        ? 'border-ember-400/50 bg-ember-400/10 text-ember-300'
                        : 'border-ink-400 bg-ink-700 text-paper-300 hover:border-ink-300 hover:text-paper-100',
                      FOCUS_RING
                    )}
                    key={p}
                    onClick={() => setPattern(p)}
                    title="Fill the key pattern"
                    type="button"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <Select
              label="Scope"
              onChange={(v) => setScope(v as GrantScope)}
              options={[
                { label: 'Whole platform', value: 'GLOBAL' },
                { label: 'One organization', value: 'ORGANIZATION' },
                { label: 'One team', value: 'TEAM' },
              ]}
              value={scope}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Select
              label="Grant to"
              onChange={(v) => setGranteeType(v as 'role' | 'user')}
              options={[
                { label: 'A role', value: 'role' },
                { label: 'A specific user', value: 'user' },
              ]}
              value={granteeType}
            />
            {granteeType === 'role' ? (
              <Select
                label="Role"
                onChange={(v) => setRole(v as GrantRole)}
                options={[
                  { label: platformRoleLabel('ADMIN'), value: 'ADMIN' },
                  { label: platformRoleLabel('LEAD'), value: 'LEAD' },
                  { label: platformRoleLabel('ENGINEER'), value: 'ENGINEER' },
                ]}
                value={role}
              />
            ) : (
              <EligibleUserSelect
                eligible={eligibleUsers}
                id="grant-user"
                label="User"
                onChange={setUserId}
                value={userId}
              />
            )}
            {scope === 'TEAM' && (
              <Combobox
                emptyMessage="No team matches"
                id="grant-team"
                label="Team"
                onChange={setTeamId}
                options={(teams ?? []).map((t) => ({ label: t.name, value: t.id }))}
                placeholder="Search teams…"
                required
                value={teamId}
              />
            )}
            {scope === 'ORGANIZATION' && (
              <Combobox
                emptyMessage="No organization matches"
                id="grant-org"
                label="Organization"
                onChange={setOrgId}
                options={(orgs ?? []).map((o) => ({ label: o.name, value: o.id }))}
                placeholder="Search organizations…"
                required
                value={orgId}
              />
            )}
          </div>

          {preview.data &&
            !preview.isError &&
            preview.data.keyPattern === pattern &&
            pattern.length > 0 && (
              <div className="rounded-lg border border-ink-500 bg-ink-900/40 p-4">
                <p className="mb-2 flex flex-wrap items-center gap-2 text-sm text-paper-200">
                  <span className="font-medium">Effective permission</span>
                  <Badge tone="neutral" variant="outline">
                    {plural(preview.data.keys.length, 'matching key')}
                  </Badge>
                  {preview.data.requiredRole && (
                    <span className="text-xs text-paper-400">
                      Highest role floor:{' '}
                      <span className="text-paper-100">
                        {platformRoleLabel(preview.data.requiredRole)}
                      </span>
                    </span>
                  )}
                </p>
                {preview.data.keys.length === 0 && (
                  <Alert variant="warning">Pattern does not match any known setting.</Alert>
                )}
                {preview.data.keys.length > 0 && (
                  <ul className="max-h-48 divide-y divide-ink-600 overflow-y-auto text-xs">
                    {preview.data.settings.map((s) => (
                      <li className="flex justify-between gap-3 py-1.5" key={s.key}>
                        <span className="truncate font-mono text-paper-200">{s.key}</span>
                        <span className="shrink-0 text-paper-500">
                          {s.group} · {platformRoleLabel(s.requiredRole)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          {preview.isError && pattern.length > 0 && (
            <Alert>{errMsg(preview.error, 'preview failed')}</Alert>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-ink-600 pt-4">
            {preview.isFetching && (
              <span className="text-xs text-paper-500" role="status">
                Updating preview…
              </span>
            )}
            <Button disabled={createGrant.isPending} type="submit" variant="primary">
              {createGrant.isPending ? 'Creating…' : 'Create grant'}
            </Button>
          </div>
        </form>
      </Card>

      <Card className="fade-up stagger-2 p-4 sm:p-6">
        <CardHeader>
          <CardTitle>Active grants</CardTitle>
          {allGrants.length > 0 && (
            <span className="text-xs text-paper-500 tabular-nums">
              {plural(allGrants.length, 'grant')}
            </span>
          )}
        </CardHeader>
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={false}
          label="grants"
          onRetry={() => void refetch()}
        >
          {isLoading ? (
            <SkeletonRows rows={3} />
          ) : allGrants.length === 0 ? (
            <EmptyState
              hint="Only admins can change settings until you grant a role or a user access to some of them."
              icon="lock"
              title="No grants yet"
            />
          ) : (
            <Table stacked>
              <THead>
                <Th className="pl-0" variant="plain">
                  Pattern
                </Th>
                <Th variant="plain">Granted to</Th>
                <Th variant="plain">Where</Th>
                <Th variant="plain">Created</Th>
                <Th className="pr-0" variant="plain">
                  <span className="sr-only">Actions</span>
                </Th>
              </THead>
              <tbody>
                {allGrants.map((g) => (
                  <TRow hover key={g.id}>
                    <Td className="py-3 pr-4" primary>
                      <span className="font-mono text-[13px] text-paper-100">{g.keyPattern}</span>
                    </Td>
                    <Td className="px-4 py-3 text-[13px]" label="Granted to">
                      {g.user?.email ? (
                        <span className="text-paper-200">{g.user.email}</span>
                      ) : g.role ? (
                        <Badge tone="neutral" variant="outline">
                          {platformRoleLabel(g.role)} role
                        </Badge>
                      ) : (
                        <span className="text-paper-500">—</span>
                      )}
                    </Td>
                    <Td className="px-4 py-3 text-[13px]" label="Where">
                      <div className="text-paper-200">
                        {g.scope === 'GLOBAL'
                          ? 'Whole platform'
                          : g.scope === 'ORGANIZATION'
                            ? 'Organization'
                            : 'Team'}
                      </div>
                      {(g.team?.name ?? g.organization?.name) && (
                        <div className="text-xs text-paper-500">
                          {g.team?.name ?? g.organization?.name}
                        </div>
                      )}
                    </Td>
                    <Td className="px-4 py-3 text-[13px] text-paper-400" label="Created">
                      <RelativeTime value={g.createdAt} />
                    </Td>
                    <Td align="right" className="py-3 pl-4">
                      <ActionMenu
                        items={[
                          {
                            disabled: revokeGrant.isPending,
                            icon: 'trash',
                            id: 'revoke',
                            label: 'Revoke grant',
                            onAction: () => setRevokeTarget(g),
                            tone: 'danger',
                          },
                        ]}
                        label={`Actions for grant ${g.keyPattern}`}
                      />
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </QueryBoundary>
      </Card>

      <ConfirmModal
        confirmLabel="Revoke"
        dangerous
        message={`Revoke the "${revokeTarget?.keyPattern}" grant? Whoever it covers loses permission to change those settings. This cannot be undone.`}
        onClose={() => setRevokeTarget(null)}
        onConfirm={confirmRevoke}
        open={revokeTarget !== null}
        title="Revoke configuration grant?"
      />
    </div>
  );
}
