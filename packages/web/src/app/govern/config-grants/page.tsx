'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Th } from '@/components/ui/Th';
import {
  type ConfigGrant,
  useConfigGrantPreview,
  useConfigGrants,
  useCreateConfigGrant,
  useRevokeConfigGrant,
} from '@/hooks/useConfigSettings';
import { errMsg } from '@/lib/errors';
import { formatRelativeTime } from '@/lib/utils';

type GrantScope = 'GLOBAL' | 'ORGANIZATION' | 'TEAM';
type GrantRole = 'ADMIN' | 'LEAD' | 'ENGINEER';

export default function GovernConfigGrantsPage() {
  const { data: grants, isLoading } = useConfigGrants();
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

  const examplePatterns = useMemo(
    () => ['*', 'channel.*', 'workflow.runConcurrency', 'memory.*', 'workspace.*'],
    []
  );

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
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

  const confirmRevoke = () => {
    if (revokeTarget) {
      revokeGrant.mutate(revokeTarget.id);
      setRevokeTarget(null);
    }
  };

  if (isLoading) {
    return <LoadingState message="loading grants…" />;
  }

  return (
    <div className="space-y-10">
      <div className="fade-up">
        <PageHeader
          chapter={`§ Admin · Config grants · ${(grants ?? []).length} active`}
          subtitle="Delegate fine-grained permission to change platform settings. Grants are bounded to known keys or groups — they never grant generic IAM or the ability to mint further grants."
          title="Configuration grants."
        />
      </div>

      <section className="fade-up stagger-1">
        <SectionHeader number="01" title="Create a grant" />
        <Card variant="inset">
          {formError && <p className="mb-3 font-mono text-[11px] text-brick-400">{formError}</p>}
          {formSuccess && <p className="mb-3 font-mono text-[11px] text-moss-400">{formSuccess}</p>}
          <form className="space-y-4" onSubmit={handleCreate}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Input
                hint="* for everything, channel.* for a group, or an exact setting key"
                label="Key pattern"
                onChange={(e) => setPattern(e.target.value)}
                placeholder="e.g. channel.*"
                required
                value={pattern}
              />
              <Select
                label="Scope"
                onChange={(e) => setScope(e.target.value as GrantScope)}
                value={scope}
              >
                <option value="GLOBAL">GLOBAL</option>
                <option value="ORGANIZATION">ORGANIZATION</option>
                <option value="TEAM">TEAM</option>
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Select
                label="Grantee type"
                onChange={(e) => setGranteeType(e.target.value as 'role' | 'user')}
                value={granteeType}
              >
                <option value="role">role</option>
                <option value="user">userId</option>
              </Select>
              {granteeType === 'role' ? (
                <Select
                  label="Role"
                  onChange={(e) => setRole(e.target.value as GrantRole)}
                  value={role}
                >
                  <option value="ADMIN">ADMIN</option>
                  <option value="LEAD">LEAD</option>
                  <option value="ENGINEER">ENGINEER</option>
                </Select>
              ) : (
                <Input
                  label="User ID"
                  onChange={(e) => setUserId(e.target.value)}
                  required
                  value={userId}
                />
              )}
              {scope === 'TEAM' && (
                <Input
                  label="Team ID"
                  onChange={(e) => setTeamId(e.target.value)}
                  required
                  value={teamId}
                />
              )}
              {scope === 'ORGANIZATION' && (
                <Input
                  label="Org ID"
                  onChange={(e) => setOrgId(e.target.value)}
                  required
                  value={orgId}
                />
              )}
            </div>
            <div className="flex items-center gap-3">
              <Button disabled={createGrant.isPending} size="md" type="submit" variant="primary">
                {createGrant.isPending ? 'Creating…' : 'Create grant →'}
              </Button>
              {preview.isFetching && (
                <span className="font-mono text-[11px] text-paper-500">preview…</span>
              )}
            </div>
          </form>

          {preview.data &&
            !preview.isError &&
            preview.data.keyPattern === pattern &&
            pattern.length > 0 && (
              <div className="mt-5 border-t border-ink-600 pt-4">
                <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-paper-500">
                  Effective permission preview
                </p>
                <p className="mb-2 text-sm text-paper-200">
                  <span className="rounded bg-ink-600 px-1.5 py-0.5 font-mono text-[11px]">
                    {preview.data.keys.length}
                  </span>{' '}
                  matching keys
                  {preview.data.requiredRole && (
                    <>
                      {' · '}
                      highest role floor:{' '}
                      <span className="text-ember-400">{preview.data.requiredRole}</span>
                    </>
                  )}
                </p>
                {preview.data.keys.length === 0 && (
                  <p className="text-xs text-brick-400">
                    Pattern does not match any known setting.
                  </p>
                )}
                {preview.data.keys.length > 0 && (
                  <ul className="max-h-48 overflow-y-auto rounded border border-ink-600 bg-ink-900/40 p-2 text-xs">
                    {preview.data.settings.map((s) => (
                      <li className="flex justify-between py-1" key={s.key}>
                        <span className="font-mono text-paper-300">{s.key}</span>
                        <span className="text-paper-500">
                          {s.group} · {s.requiredRole}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          {preview.isError && pattern.length > 0 && (
            <p className="mt-3 font-mono text-[11px] text-brick-400">
              {errMsg(preview.error, 'preview failed')}
            </p>
          )}
        </Card>
      </section>

      <section className="fade-up stagger-2">
        <SectionHeader hint="quick picks" number="02" title="Valid patterns" />
        <div className="flex flex-wrap gap-2">
          {examplePatterns.map((p) => (
            <Button key={p} onClick={() => setPattern(p)} size="sm" variant="ghost">
              {p}
            </Button>
          ))}
        </div>
      </section>

      <section className="fade-up stagger-3">
        <SectionHeader number="03" title="Active grants" />
        <Card className="overflow-hidden p-0" variant="inset">
          {(grants ?? []).length === 0 ? (
            <p className="px-4 py-8 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
              no grants configured
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-600">
                  <Th>Pattern</Th>
                  <Th>Scope</Th>
                  <Th>Grantee</Th>
                  <Th>Bound to</Th>
                  <Th>Created</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {(grants ?? []).map((g) => (
                  <tr className="border-b border-ink-600 last:border-b-0" key={g.id}>
                    <td className="px-4 py-3 font-mono text-[11px] text-paper-200">
                      {g.keyPattern}
                    </td>
                    <td className="px-4 py-3 font-mono text-[10px] uppercase text-paper-400">
                      {g.scope}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-paper-300">
                      {g.user?.email ?? g.role ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-paper-500">
                      {g.team?.name ?? g.organization?.name ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-paper-400">
                      {formatRelativeTime(g.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        disabled={revokeGrant.isPending}
                        onClick={() => setRevokeTarget(g)}
                        size="sm"
                        variant="danger"
                      >
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>

      <ConfirmModal
        confirmLabel="Revoke"
        dangerous
        message={`Revoke the "${revokeTarget?.keyPattern}" grant? This cannot be undone.`}
        onClose={() => setRevokeTarget(null)}
        onConfirm={confirmRevoke}
        open={revokeTarget !== null}
        title="Revoke configuration grant"
      />
    </div>
  );
}
