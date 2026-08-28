'use client';

import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
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
  const schema = template.inputSchema as InputSchema | null | undefined;

  const [payload, setPayload] = useState<Record<string, unknown>>(
    schema ? buildInitialPayload(schema) : {}
  );
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [launchedRunId, setLaunchedRunId] = useState<string | null>(null);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);

  const handleClose = () => {
    onClose();
    setError(null);
    setLaunchedRunId(null);
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
      const result = await runTemplate.mutateAsync({ label: label.trim() || undefined, payload });
      setLaunchedRunId(result.workflowId);
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

  if (launchedRunId) {
    return (
      <Modal
        eyebrow={`§ ${template.name}`}
        onClose={handleClose}
        open={open}
        title="Workflow started"
      >
        <div className="space-y-6 py-2 text-center">
          <div className="text-3xl text-moss-400">✓</div>
          <p className="text-sm text-paper-300">
            Your workflow is running. Track its progress in the run detail view.
          </p>
          <div className="flex justify-center gap-3 pt-2">
            <Button onClick={handleClose} variant="secondary">
              Close
            </Button>
            <Link href={`/runs/${launchedRunId}`} onClick={handleClose}>
              <Button variant="primary">View run →</Button>
            </Link>
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

        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={handleClose} variant="secondary">
            Cancel
          </Button>
          <Button
            disabled={!isValid || runTemplate.isPending}
            onClick={handleRun}
            variant="primary"
          >
            {runTemplate.isPending ? 'Starting…' : 'Run →'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
