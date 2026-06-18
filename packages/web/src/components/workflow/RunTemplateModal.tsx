'use client';

import type { InputSchema, InputSchemaProperty } from '@auto-swe/shared/lib/inputSchema';
import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useRunTemplate } from '@/hooks/useTemplates';

function FieldInput({
  name,
  prop,
  value,
  onChange,
}: {
  name: string;
  prop: InputSchemaProperty;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = name.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
  const hint = prop.description;

  if (prop.type === 'boolean') {
    return (
      <label className="flex cursor-pointer items-center gap-3">
        <input
          checked={Boolean(value)}
          className="h-4 w-4 accent-ember-400"
          onChange={(e) => onChange(e.target.checked)}
          type="checkbox"
        />
        <span className="text-sm text-paper-200">
          {label}
          {hint && <span className="ml-1 text-paper-500">— {hint}</span>}
        </span>
      </label>
    );
  }

  if (prop.enum) {
    return (
      <Select
        hint={hint}
        label={label}
        onChange={(e) => onChange(e.target.value)}
        value={typeof value === 'string' ? value : ''}
      >
        <option value="">— select —</option>
        {prop.enum.map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {String(opt)}
          </option>
        ))}
      </Select>
    );
  }

  if (prop.type === 'number') {
    return (
      <Input
        hint={hint}
        label={label}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        type="number"
        value={typeof value === 'number' ? String(value) : ''}
      />
    );
  }

  // string (including uuid format) and fallback
  return (
    <Input
      hint={prop.format === 'uuid' ? `${hint ?? ''} (UUID)`.trim() : hint}
      label={label}
      onChange={(e) => onChange(e.target.value)}
      placeholder={prop.format === 'uuid' ? 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' : undefined}
      value={typeof value === 'string' ? value : ''}
    />
  );
}

function buildInitialPayload(schema: InputSchema): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.type === 'boolean') {
      payload[key] = false;
    } else if (prop.enum && prop.enum.length > 0) {
      payload[key] = prop.enum[0];
    } else {
      payload[key] = '';
    }
  }
  return payload;
}

export function RunTemplateModal({
  template,
  open,
  onClose,
}: {
  template: WorkflowTemplateSummary;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const runTemplate = useRunTemplate(template.id);
  const schema = template.inputSchema as InputSchema | null | undefined;

  const [payload, setPayload] = useState<Record<string, unknown>>(
    schema ? buildInitialPayload(schema) : {}
  );
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    onClose();
    setError(null);
  };

  const handleRun = async () => {
    setError(null);
    try {
      const result = await runTemplate.mutateAsync({ label: label.trim() || undefined, payload });
      handleClose();
      router.push(`/runs/${result.workRequestId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Run failed';
      setError(msg);
    }
  };

  const setField = (key: string, value: unknown) => {
    setPayload((prev) => ({ ...prev, [key]: value }));
  };

  const hasSchema = schema && Object.keys(schema.properties).length > 0;

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
            <FieldInput
              key={key}
              name={key}
              onChange={(v) => setField(key, v)}
              prop={prop}
              value={payload[key]}
            />
          ))}

        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={handleClose} variant="secondary">
            Cancel
          </Button>
          <Button disabled={runTemplate.isPending} onClick={handleRun} variant="primary">
            {runTemplate.isPending ? 'Starting…' : 'Run →'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
