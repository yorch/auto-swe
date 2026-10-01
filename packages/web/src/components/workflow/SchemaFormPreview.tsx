'use client';

import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalFooter } from '@/components/ui/Modal';
import { buildInitialPayload, SchemaFieldInput } from './schemaForm';

export function SchemaFormPreview({ schema }: { schema: InputSchema | null | undefined }) {
  const [payload, setPayload] = useState<Record<string, unknown>>(
    schema ? buildInitialPayload(schema) : {}
  );

  if (!schema || Object.keys(schema.properties).length === 0) {
    return (
      <EmptyState
        className="rounded border border-dashed border-ink-600 py-6 text-xs"
        title="No fields defined — add fields above to see a preview."
      />
    );
  }

  const requiredKeys = new Set(schema.required ?? []);

  const setField = (key: string, value: unknown) => {
    setPayload((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-4">
      <div className="label-mono">Preview — how this form will look to users</div>
      <Card className="space-y-4 p-4" variant="inset">
        {Object.entries(schema.properties).map(([key, prop]) => (
          <SchemaFieldInput
            key={key}
            name={key}
            onChange={(v) => setField(key, v)}
            prop={prop}
            required={requiredKeys.has(key)}
            value={payload[key]}
          />
        ))}
        {/* The run modal's own footer, inert: this is a preview. */}
        <ModalFooter disabled onCancel={() => undefined} submitLabel="Run →" />
      </Card>
    </div>
  );
}
