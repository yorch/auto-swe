'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useOrganizationDirectory } from '@/hooks/useAdmin';
import { useHasRole } from '@/hooks/useHasRole';
import { useOrgMembers } from '@/hooks/useOrg';
import { useCreateTeam, useUpdateTeam } from '@/hooks/useTeams';
import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';

type Mode =
  | { kind: 'create'; orgId?: string }
  | { kind: 'edit'; teamId: string; initial: { name: string; description?: string | null } };

export function TeamFormModal({
  open,
  onClose,
  mode,
}: {
  open: boolean;
  onClose: () => void;
  mode: Mode;
}) {
  const create = useCreateTeam();
  const update = useUpdateTeam(mode.kind === 'edit' ? mode.teamId : '');
  const platformAdmin = useHasRole('ADMIN');
  const directory = useOrganizationDirectory();
  const organizations = (directory.data ?? []).filter(
    (o) => platformAdmin || o.role === 'ORG_ADMIN'
  );
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [adminUserId, setAdminUserId] = useState('');
  const fixedOrgId = mode.kind === 'create' ? mode.orgId : undefined;
  const orgId =
    fixedOrgId ?? (selectedOrgId || (organizations.length === 1 ? organizations[0].id : ''));
  const members = useOrgMembers(open && mode.kind === 'create' ? orgId : '');

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The parent builds `mode` as a fresh object every render, and its team query
  // refetches on window focus. Resetting on `mode` would wipe what the user is
  // typing each time that happens, so the form resets only when it opens or
  // switches team, reading the latest `mode` through a ref.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const formKey = mode.kind === 'edit' ? mode.teamId : 'create';

  // biome-ignore lint/correctness/useExhaustiveDependencies: `formKey` is the intentional reset trigger; `mode` is read through a ref
  useEffect(() => {
    if (!open) {
      return;
    }
    const current = modeRef.current;
    if (current.kind === 'edit') {
      setName(current.initial.name);
      setSlug('');
      setDescription(current.initial.description ?? '');
    } else {
      setName('');
      setSlug('');
      setDescription('');
      setSelectedOrgId('');
      setAdminUserId('');
    }
    setError(null);
  }, [open, formKey]);

  function deriveSlug(value: string) {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (mode.kind === 'create') {
        if (!orgId && !platformAdmin) {
          setError('Choose an organization you administer.');
          return;
        }
        await create.mutateAsync({
          adminUserId: adminUserId || undefined,
          description: description.trim() || undefined,
          name: name.trim(),
          orgId: orgId || undefined,
          slug: slug.trim() || deriveSlug(name),
        });
      } else {
        await update.mutateAsync({
          description: description.trim(),
          name: name.trim(),
        });
      }
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'TEAM_EXISTS'
          ? 'A team with this name or slug already exists. Choose another name or slug.'
          : err instanceof ApiError && err.code === 'ORG_MEMBERSHIP_REQUIRED'
            ? 'The first admin must belong to the selected organization. Choose an organization member.'
            : errMsg(err, 'Failed to save team')
      );
    }
  }

  const isEdit = mode.kind === 'edit';
  const busy = create.isPending || update.isPending;

  return (
    <Modal
      onClose={onClose}
      open={open}
      subtitle="Teams scope repositories, workflow templates, and agent lessons."
      title={isEdit ? 'Edit team' : 'Create team'}
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        {!isEdit && !fixedOrgId && organizations.length > 1 && (
          <Select
            label="Organization"
            onChange={(value) => {
              setSelectedOrgId(value);
              setAdminUserId('');
            }}
            options={[
              { label: platformAdmin ? 'Default organization' : 'Choose organization', value: '' },
              ...organizations.map((o) => ({ label: o.name, value: o.id })),
            ]}
            value={orgId}
          />
        )}
        {!isEdit && orgId && (
          <Select
            disabled={members.isLoading || members.isError}
            error={
              members.isError
                ? 'Unable to load organization members. Reopen the dialog to retry.'
                : undefined
            }
            hint="Defaults to you. Another admin must be a member of this organization."
            label="First team admin"
            onChange={setAdminUserId}
            options={[
              { label: 'You (creator)', value: '' },
              ...(members.data ?? []).map((m) => ({ label: m.user.email, value: m.userId })),
            ]}
            value={adminUserId}
          />
        )}
        <Input
          autoFocus
          label="Name"
          onChange={(e) => setName(e.target.value)}
          placeholder="Payments Platform"
          required
          value={name}
        />
        {!isEdit && (
          <Input
            hint="Lowercase letters, numbers and hyphens. Derived from the name when left blank."
            label="Slug"
            onChange={(e) => setSlug(e.target.value)}
            pattern="[a-z0-9-]+"
            placeholder={deriveSlug(name) || 'payments-platform'}
            value={slug}
          />
        )}
        <Input
          label="Description (optional)"
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this team owns"
          value={description}
        />
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          isPending={busy}
          onCancel={onClose}
          pendingLabel="Saving…"
          submitLabel={isEdit ? 'Save changes' : 'Create team'}
        />
      </form>
    </Modal>
  );
}
