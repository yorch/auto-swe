'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { useCreateTeam, useUpdateTeam } from '@/hooks/useTeams';
import { errMsg } from '@/lib/errors';

type Mode =
  | { kind: 'create' }
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
        await create.mutateAsync({
          description: description.trim() || undefined,
          name: name.trim(),
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
      setError(errMsg(err, 'Failed to save team'));
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
            hint="lowercase-kebab-case. Auto-derived from the name if blank."
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
