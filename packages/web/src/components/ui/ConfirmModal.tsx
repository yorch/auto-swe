'use client';

import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

export function ConfirmModal({
  closeOnConfirm = true,
  confirmLabel = 'Confirm',
  dangerous = false,
  error,
  message,
  onClose,
  onConfirm,
  open,
  title,
}: {
  closeOnConfirm?: boolean;
  confirmLabel?: string;
  dangerous?: boolean;
  error?: string;
  message: string;
  onClose: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}) {
  return (
    <Modal onClose={onClose} open={open} title={title}>
      <p className="text-sm text-paper-400">{message}</p>
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end gap-3 pt-2">
        <Button onClick={onClose} type="button" variant="ghost">
          Cancel
        </Button>
        <Button
          onClick={() => {
            onConfirm();
            if (closeOnConfirm) {
              onClose();
            }
          }}
          type="button"
          variant={dangerous ? 'danger' : 'primary'}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
