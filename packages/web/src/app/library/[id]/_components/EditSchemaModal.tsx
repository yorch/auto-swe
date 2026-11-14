import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { InputSchemaBuilder } from '@/components/workflow/InputSchemaBuilder';
import { SchemaFormPreview } from '@/components/workflow/SchemaFormPreview';
import { useUpdateWorkflowTemplate } from '@/hooks/useTemplates';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
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
  const [problem, setProblem] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const handleProblem = useCallback((p: string | null) => setProblem(p), []);
  const dirty =
    open && (problem !== null || JSON.stringify(schema) !== JSON.stringify(initialSchema ?? null));
  useUnsavedChangesGuard(dirty);

  useEffect(() => {
    if (open) {
      setSchema(initialSchema ?? null);
      setBuilderKey((k) => k + 1);
      setError(null);
      setPreview(false);
      setDiscardOpen(false);
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

  const requestClose = () => {
    if (updateTemplate.isPending) {
      return;
    }
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  };

  return (
    <>
      <ConfirmModal
        confirmLabel="Discard changes"
        dangerous
        message="You have unsaved launch input edits. Closing discards them."
        onClose={() => setDiscardOpen(false)}
        onConfirm={() => {
          setDiscardOpen(false);
          onClose();
        }}
        open={discardOpen}
        title="Discard unsaved changes?"
      />
      <Modal
        dismissible={!updateTemplate.isPending}
        onClose={requestClose}
        open={open}
        size="lg"
        subtitle="Define the fields people fill in when they run this workflow. Leave empty for no required inputs."
        title="Launch inputs"
      >
        <div className="space-y-4">
          <p className="text-xs text-paper-500">
            Changes to launch inputs apply to the active version immediately.
          </p>
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
          {preview && <SchemaFormPreview schema={schema} />}
          {/* Hidden, not unmounted, so unfinished rows survive a trip to the preview. */}
          <div hidden={preview}>
            <InputSchemaBuilder
              key={builderKey}
              onChange={setSchema}
              onProblemChange={handleProblem}
              value={initialSchema ?? undefined}
            />
          </div>
          <ModalFooter
            disabled={preview || problem !== null}
            isPending={updateTemplate.isPending}
            onCancel={requestClose}
            onSubmit={handleSave}
            pendingLabel="Saving…"
            submitLabel="Save changes"
          >
            {(preview || problem) && (
              <p className="text-xs text-paper-400">
                {preview ? 'Switch to Fields to save.' : problem}
              </p>
            )}
          </ModalFooter>
        </div>
      </Modal>
    </>
  );
}
