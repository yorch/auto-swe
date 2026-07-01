'use client';

import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { buildInitialPayload, SchemaFieldInput } from './schemaForm';

export function SchemaFormPreview({ schema }: { schema: InputSchema | null | undefined }) {
  const [payload, setPayload] = useState<Record<string, unknown>>(
    schema ? buildInitialPayload(schema) : {}
  );

  if (!schema || Object.keys(schema.properties).length === 0) {
    return (
      <p className="rounded border border-dashed border-ink-600 py-6 text-center text-xs text-paper-500">
        No fields defined — add fields above to see a preview
      </p>
    );
  }

  const requiredKeys = new Set(schema.required ?? []);

  const setField = (key: string, value: unknown) => {
    setPayload((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
          Preview — how this form will look to users
        </span>
      </div>
      <div className="space-y-4 rounded border border-ink-600 bg-ink-900 p-4">
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
        <div className="flex justify-end gap-2 border-t border-ink-600 pt-3">
          <Button disabled size="sm" variant="secondary">
            Cancel
          </Button>
          <Button disabled size="sm" variant="primary">
            Run →
          </Button>
        </div>
      </div>
    </div>
  );
}
