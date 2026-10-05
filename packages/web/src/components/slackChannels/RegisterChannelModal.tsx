'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { useCreateSlackChannel } from '@/hooks/useSlackChannels';
import { errMsg } from '@/lib/errors';
import {
  type ChannelFormErrors,
  type ChannelFormState,
  emptyChannelForm,
  formToCreateBody,
  validateChannelForm,
} from '@/lib/slackChannelForm';
import { ChannelForm } from './ChannelForm';

/** Registers a channel and, once saved, hands its new id back so the caller can open its page. */
export function RegisterChannelModal({
  onClose,
  onRegistered,
  open,
}: {
  onClose: () => void;
  onRegistered: (id: string) => void;
  open: boolean;
}) {
  const create = useCreateSlackChannel();
  const [form, setForm] = useState<ChannelFormState>(emptyChannelForm);
  const [errors, setErrors] = useState<ChannelFormErrors>({});
  const [error, setError] = useState<string | null>(null);

  function close() {
    setForm(emptyChannelForm());
    setErrors({});
    setError(null);
    onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const found = validateChannelForm(form, 'create');
    setErrors(found);
    if (Object.keys(found).length > 0) {
      return;
    }
    try {
      const created = await create.mutateAsync(formToCreateBody(form));
      setForm(emptyChannelForm());
      onClose();
      onRegistered(created.id);
    } catch (err) {
      setError(errMsg(err, 'Could not register the channel'));
    }
  }

  return (
    <Modal onClose={close} open={open} size="lg" title="Register Slack channel">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <ChannelForm
          errors={errors}
          form={form}
          mode="create"
          onChange={(key, value) => {
            setForm((f) => ({ ...f, [key]: value }));
            setErrors((prev) => ({ ...prev, [key]: undefined }));
          }}
        />
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          isPending={create.isPending}
          onCancel={close}
          pendingLabel="Registering…"
          submitLabel="Register channel"
        />
      </form>
    </Modal>
  );
}
