import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useUpdateWorkflowTemplate } from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';

export function EditMetadataModal({
  open,
  onClose,
  templateId,
  initialName,
  initialDescription,
  isDefault,
  initialEstimatedHumanTimeSavedMinutes,
}: {
  open: boolean;
  onClose: () => void;
  templateId: string;
  initialName: string;
  initialDescription: string;
  isDefault: boolean;
  initialEstimatedHumanTimeSavedMinutes: number | null;
}) {
  const updateTemplate = useUpdateWorkflowTemplate(templateId);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [defaultChecked, setDefaultChecked] = useState(isDefault);
  const [estimatedMinutes, setEstimatedMinutes] = useState<number | null>(
    initialEstimatedHumanTimeSavedMinutes
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setDescription(initialDescription);
      setDefaultChecked(isDefault);
      setEstimatedMinutes(initialEstimatedHumanTimeSavedMinutes);
      setError(null);
    }
  }, [open, initialName, initialDescription, isDefault, initialEstimatedHumanTimeSavedMinutes]);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    if (estimatedMinutes != null && estimatedMinutes < 0) {
      setError('Estimated human time saved cannot be negative');
      return;
    }
    setError(null);
    try {
      await updateTemplate.mutateAsync({
        description: description.trim() || undefined,
        estimatedHumanTimeSavedMinutes: estimatedMinutes,
        isDefault: defaultChecked,
        name: trimmed,
      });
      onClose();
    } catch (err) {
      setError(errMsg(err, 'save failed'));
    }
  };

  return (
    <Modal onClose={onClose} open={open} title="Edit metadata">
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Input label="Name" onChange={(e) => setName(e.target.value)} value={name} />
        <Textarea
          hint="Optional"
          label="Description"
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          value={description}
        />
        <Input
          hint="Optional — minutes saved per run"
          label="Estimated human time saved"
          min={0}
          onChange={(e) => {
            const v = e.target.value;
            setEstimatedMinutes(v === '' ? null : Number(v));
          }}
          step={0.1}
          type="number"
          value={estimatedMinutes ?? ''}
        />
        <ToggleSwitch
          checked={defaultChecked}
          label="Set as default workflow"
          onChange={() => setDefaultChecked((v) => !v)}
        />
        <ModalFooter
          isPending={updateTemplate.isPending}
          onCancel={onClose}
          onSubmit={handleSave}
          pendingLabel="Saving…"
          submitLabel="Save changes"
        />
      </div>
    </Modal>
  );
}
