'use client';

import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

export function ConfirmModal({
  confirmLabel = 'Confirm',
  dangerous = false,
  message,
  onClose,
  onConfirm,
  open,
  title,
}: {
  confirmLabel?: string;
  dangerous?: boolean;
  message: string;
  onClose: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}) {
  return (
    <Modal onClose={onClose} open={open} title={title}>
      <p className="text-sm text-paper-400">{message}</p>
      <div className="flex justify-end gap-3 pt-2">
        <Button onClick={onClose} type="button" variant="ghost">
          Cancel
        </Button>
        <Button
          onClick={() => {
            onConfirm();
            onClose();
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
