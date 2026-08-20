'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
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

  useEffect(() => {
    if (!open) {
      return;
    }
    if (mode.kind === 'edit') {
      setName(mode.initial.name);
      setSlug('');
      setDescription(mode.initial.description ?? '');
    } else {
      setName('');
      setSlug('');
      setDescription('');
    }
    setError(null);
  }, [open, mode]);

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
      eyebrow={isEdit ? '§ Edit team' : '§ New team'}
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
        {error && (
          <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">{error}</p>
        )}
        <div className="flex items-center justify-end gap-3 border-t border-ink-600 pt-4">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy} type="submit" variant="primary">
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create team'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
