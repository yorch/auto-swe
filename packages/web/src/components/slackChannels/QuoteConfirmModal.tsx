'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { errMsg } from '@/lib/errors';

/**
 * A confirm dialog that shows the text being acted on as a quoted block, so a multi-line lesson
 * or message keeps its line breaks instead of collapsing into the sentence around it.
 */
export function QuoteConfirmModal({
  confirmLabel,
  intro,
  onClose,
  onConfirm,
  open,
  quote,
  title,
}: {
  confirmLabel: string;
  intro: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  open: boolean;
  quote: string;
  title: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setError(null);
    onClose();
  }

  async function confirm() {
    setError(null);
    setPending(true);
    try {
      await onConfirm();
      close();
    } catch (err) {
      setError(errMsg(err, 'Request failed'));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal onClose={close} open={open} title={title}>
      <p className="text-sm text-paper-400">{intro}</p>
      <blockquote className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-[9px] border-l-2 border-ember-400 bg-ink-900/60 px-3 py-2 text-sm text-paper-200">
        {quote}
      </blockquote>
      {error && <Alert>{error}</Alert>}
      <ModalFooter
        dangerous
        isPending={pending}
        onCancel={close}
        onSubmit={confirm}
        submitLabel={confirmLabel}
      />
    </Modal>
  );
}
