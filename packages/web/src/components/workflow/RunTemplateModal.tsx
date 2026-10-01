'use client';

import { type InputSchema, isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { useRunTemplate } from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';
import { buildInitialPayload, SchemaFieldInput, validatePayload } from './schemaForm';

export function RunTemplateModal({
  template,
  open,
  onClose,
}: {
  template: WorkflowTemplateSummary;
  open: boolean;
  onClose: () => void;
}) {
  const runTemplate = useRunTemplate(template.id);
  const schema: InputSchema | null = isInputSchema(template.inputSchema)
    ? template.inputSchema
    : null;

  const [payload, setPayload] = useState<Record<string, unknown>>(
    schema ? buildInitialPayload(schema) : {}
  );
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The launched workflow's id; non-null once the run has started.
  const [launchedId, setLaunchedId] = useState<string | null>(null);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);

  const handleClose = () => {
    onClose();
    setError(null);
    setLaunchedId(null);
    setAttemptedSubmit(false);
    setLabel('');
    setPayload(schema ? buildInitialPayload(schema) : {});
  };

  const fieldErrors = schema ? validatePayload(schema, payload) : {};
  const isValid = Object.keys(fieldErrors).length === 0;

  const handleRun = async () => {
    setAttemptedSubmit(true);
    setError(null);
    if (!isValid) {
      return;
    }
    try {
      const { workflowId } = await runTemplate.mutateAsync({
        label: label.trim() || undefined,
        payload,
      });
      setLaunchedId(workflowId);
    } catch (err) {
      const msg = errMsg(err, 'Run failed');
      setError(msg);
    }
  };

  const setField = (key: string, value: unknown) => {
    setPayload((prev) => ({ ...prev, [key]: value }));
  };

  const hasSchema = schema && Object.keys(schema.properties).length > 0;
  const requiredKeys = new Set(schema?.required ?? []);

  if (launchedId) {
    return (
      <Modal
        eyebrow={`§ ${template.name}`}
        onClose={handleClose}
        open={open}
        title="Workflow started"
      >
        <div className="space-y-6">
          <Alert variant="success">Your workflow is running.</Alert>
          {/* ModalFooter's action is a button; this one navigates, so it is a link. */}
          <div className="flex justify-end gap-3 border-t border-ink-600 pt-4">
            <Button onClick={handleClose} variant="ghost">
              Close
            </Button>
            <ButtonLink href={`/workflows/${launchedId}`} onClick={handleClose} variant="primary">
              View workflow →
            </ButtonLink>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      eyebrow={`§ ${template.name}`}
      onClose={handleClose}
      open={open}
      subtitle={template.description || undefined}
      title="Run workflow"
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}

        {!hasSchema && (
          <Input
            hint="Optional label for this run"
            label="Run label"
            onChange={(e) => setLabel(e.target.value)}
            placeholder={`run-${Date.now()}`}
            value={label}
          />
        )}

        {hasSchema &&
          Object.entries(schema.properties).map(([key, prop]) => (
            <SchemaFieldInput
              error={attemptedSubmit ? fieldErrors[key] : undefined}
              key={key}
              name={key}
              onChange={(v) => setField(key, v)}
              prop={prop}
              required={requiredKeys.has(key)}
              value={payload[key]}
            />
          ))}

        <ModalFooter
          disabled={!isValid}
          isPending={runTemplate.isPending}
          onCancel={handleClose}
          onSubmit={handleRun}
          pendingLabel="Starting…"
          submitLabel="Run →"
        />
      </div>
    </Modal>
  );
}
