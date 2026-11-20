'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useCreateTeam } from '@/hooks/useTeams';
import {
  type CreatableOrg,
  createTeamError,
  deriveSlug,
  isValidSlug,
  lengthState,
  MAX_TEAM_DESCRIPTION_LENGTH,
  MAX_TEAM_NAME_LENGTH,
  MAX_TEAM_SLUG_LENGTH,
} from '@/lib/joinRequests';
import { teamHref } from '@/lib/teamSpace';

/**
 * Create a team in one of the organizations the server says the caller may create in
 * (`creatableOrgs` of the directory), then open its space.
 */
export function CreateTeamDialog({
  creatableOrgs,
  onClose,
  open,
}: {
  creatableOrgs: readonly CreatableOrg[];
  onClose: () => void;
  open: boolean;
}) {
  const router = useRouter();
  const create = useCreateTeam();
  const [orgId, setOrgId] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<{ field: 'name' | 'slug' | null; message: string } | null>(
    null
  );

  useEffect(() => {
    if (open) {
      setOrgId(creatableOrgs.length === 1 ? creatableOrgs[0].id : '');
      setName('');
      setSlug('');
      setSlugEdited(false);
      setDescription('');
      setError(null);
    }
  }, [open, creatableOrgs]);

  function changeName(value: string) {
    setName(value);
    if (!slugEdited) {
      setSlug(deriveSlug(value));
    }
  }

  const slugInvalid = slug.length > 0 && !isValidSlug(slug);
  const descriptionLength = lengthState(description, MAX_TEAM_DESCRIPTION_LENGTH);
  const ready = !!orgId && name.trim().length > 0 && isValidSlug(slug) && !descriptionLength.over;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) {
      return;
    }
    setError(null);
    try {
      const res = await create.mutateAsync({
        description: description.trim() || undefined,
        name: name.trim(),
        orgId,
        slug,
      });
      onClose();
      router.push(teamHref(res.data?.slug ?? slug));
    } catch (err) {
      setError(createTeamError(err));
    }
  }

  return (
    <Modal
      onClose={onClose}
      open={open}
      subtitle="You become the team's admin and can add repositories and members."
      title="Create team"
    >
      <form className="space-y-5" onSubmit={submit}>
        {creatableOrgs.length === 1 ? (
          <p className="text-sm text-paper-300">
            <span className="text-paper-500">Organization: </span>
            {creatableOrgs[0].name}
          </p>
        ) : (
          <Select
            label="Organization"
            onChange={setOrgId}
            options={[
              { label: 'Choose organization', value: '' },
              ...creatableOrgs.map((o) => ({ label: o.name, value: o.id })),
            ]}
            required
            value={orgId}
          />
        )}
        <Input
          autoFocus
          error={error?.field === 'name' ? error.message : undefined}
          label="Name"
          maxLength={MAX_TEAM_NAME_LENGTH}
          onChange={(e) => changeName(e.target.value)}
          placeholder="Payments Platform"
          required
          value={name}
        />
        <Input
          error={
            error?.field === 'slug'
              ? error.message
              : slugInvalid
                ? 'Use lowercase letters, numbers and single hyphens.'
                : undefined
          }
          hint="Lowercase letters, numbers and hyphens. Filled in from the name; you may edit it."
          label="Slug"
          maxLength={MAX_TEAM_SLUG_LENGTH}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value);
          }}
          required
          spellCheck={false}
          value={slug}
        />
        <Textarea
          hint={`${descriptionLength.count} / ${MAX_TEAM_DESCRIPTION_LENGTH} characters`}
          label="Description (optional)"
          maxLength={MAX_TEAM_DESCRIPTION_LENGTH}
          mono={false}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this team owns"
          rows={3}
          value={description}
        />
        {error && !error.field && <Alert>{error.message}</Alert>}
        <ModalFooter
          disabled={!ready}
          isPending={create.isPending}
          onCancel={onClose}
          pendingLabel="Creating…"
          submitLabel="Create team"
        />
      </form>
    </Modal>
  );
}
