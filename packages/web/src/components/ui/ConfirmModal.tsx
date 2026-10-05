'use client';

import { type ReactNode, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { errMsg } from '@/lib/errors';

/**
 * Confirm / cancel dialog. `onConfirm` may return a promise: the confirm
 * button is disabled (showing `pendingLabel`) until it settles, a rejection is
 * shown inline instead of closing, and `closeOnConfirm` only closes after
 * success. Synchronous callers behave exactly as before. While the promise is
 * pending the dialog cannot be dismissed (Cancel, Escape, the close button,
 * the backdrop), so a delete that is still running is never mistaken for one
 * that was cancelled. `confirmText` makes the confirm button wait for the user
 * to type that exact string, for actions whose blast radius deserves it.
 */
export function ConfirmModal({
  closeOnConfirm = true,
  confirmLabel = 'Confirm',
  confirmText,
  dangerous = false,
  error,
  message,
  onClose,
  onConfirm,
  open,
  pendingLabel,
  title,
}: {
  closeOnConfirm?: boolean;
  confirmLabel?: string;
  /** When set, the confirm button stays disabled until the user types exactly this. */
  confirmText?: string;
  dangerous?: boolean;
  error?: string;
  message: ReactNode;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  open: boolean;
  /** Label while an async `onConfirm` is in flight; defaults to `confirmLabel` + "…". */
  pendingLabel?: string;
  title: string;
}) {
  const [pending, setPending] = useState(false);
  const [asyncError, setAsyncError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  const handleClose = () => {
    setAsyncError(null);
    setTyped('');
    onClose();
  };

  const handleConfirm = async () => {
    if (confirmText !== undefined && typed !== confirmText) {
      return;
    }
    setAsyncError(null);
    try {
      const result = onConfirm();
      if (result instanceof Promise) {
        setPending(true);
        await result;
      }
      if (closeOnConfirm) {
        handleClose();
      }
    } catch (err) {
      setAsyncError(errMsg(err, 'Request failed'));
    } finally {
      setPending(false);
    }
  };

  const shownError = error ?? asyncError;

  return (
    <Modal dismissible={!pending} onClose={handleClose} open={open} title={title}>
      <div className="text-sm text-paper-400">{message}</div>
      {confirmText !== undefined && (
        <Input
          autoComplete="off"
          label={`Type ${confirmText} to confirm`}
          onChange={(e) => setTyped(e.target.value)}
          value={typed}
        />
      )}
      {shownError && <Alert>{shownError}</Alert>}
      <ModalFooter
        dangerous={dangerous}
        disabled={confirmText !== undefined && typed !== confirmText}
        isPending={pending}
        onCancel={handleClose}
        onSubmit={handleConfirm}
        pendingLabel={pendingLabel}
        submitLabel={confirmLabel}
      />
    </Modal>
  );
}
