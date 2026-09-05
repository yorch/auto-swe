'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { errMsg } from '@/lib/errors';

/**
 * Confirm / cancel dialog. `onConfirm` may return a promise: the confirm
 * button is disabled (showing `pendingLabel`) until it settles, a rejection is
 * shown inline instead of closing, and `closeOnConfirm` only closes after
 * success. Synchronous callers behave exactly as before.
 */
export function ConfirmModal({
  closeOnConfirm = true,
  confirmLabel = 'Confirm',
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
  dangerous?: boolean;
  error?: string;
  message: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  open: boolean;
  /** Label while an async `onConfirm` is in flight; defaults to `confirmLabel` + "…". */
  pendingLabel?: string;
  title: string;
}) {
  const [pending, setPending] = useState(false);
  const [asyncError, setAsyncError] = useState<string | null>(null);

  const handleClose = () => {
    setAsyncError(null);
    onClose();
  };

  const handleConfirm = async () => {
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
    <Modal onClose={handleClose} open={open} title={title}>
      <p className="text-sm text-paper-400">{message}</p>
      {shownError && <Alert>{shownError}</Alert>}
      <div className="flex justify-end gap-3 pt-2">
        <Button onClick={handleClose} type="button" variant="ghost">
          Cancel
        </Button>
        <Button
          disabled={pending}
          onClick={handleConfirm}
          type="button"
          variant={dangerous ? 'danger' : 'primary'}
        >
          {pending ? (pendingLabel ?? `${confirmLabel}…`) : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
