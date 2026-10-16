import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { InputSchemaBuilder } from '@/components/workflow/InputSchemaBuilder';
import { SchemaFormPreview } from '@/components/workflow/SchemaFormPreview';
import { useUpdateWorkflowTemplate } from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';

export function EditSchemaModal({
  open,
  onClose,
  templateId,
  initialSchema,
}: {
  open: boolean;
  onClose: () => void;
  templateId: string;
  initialSchema: InputSchema | null | undefined;
}) {
  const updateTemplate = useUpdateWorkflowTemplate(templateId);
  const [schema, setSchema] = useState<InputSchema | null>(initialSchema ?? null);
  const [builderKey, setBuilderKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    if (open) {
      setSchema(initialSchema ?? null);
      setBuilderKey((k) => k + 1);
      setError(null);
      setPreview(false);
    }
  }, [open, initialSchema]);

  const handleSave = async () => {
    setError(null);
    try {
      await updateTemplate.mutateAsync({ inputSchema: schema ?? null });
      onClose();
    } catch (err) {
      setError(errMsg(err, 'save failed'));
    }
  };

  return (
    <Modal
      onClose={onClose}
      open={open}
      size="lg"
      subtitle="Define the fields people fill in when they run this workflow. Leave empty for no required inputs."
      title="Launch inputs"
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <SegmentedControl
          ariaLabel="Launch inputs view"
          onChange={(v) => setPreview(v === 'preview')}
          options={[
            { label: 'Fields', value: 'edit' },
            { label: 'Preview form', value: 'preview' },
          ]}
          value={preview ? 'preview' : 'edit'}
        />
        {preview ? (
          <SchemaFormPreview schema={schema} />
        ) : (
          <InputSchemaBuilder key={builderKey} onChange={setSchema} value={schema ?? undefined} />
        )}
        <ModalFooter
          disabled={preview}
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
