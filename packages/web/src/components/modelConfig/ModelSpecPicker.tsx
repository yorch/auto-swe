'use client';

import { Combobox } from '@/components/ui/Combobox';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { type ModelKind, modelSpecOptions } from '@/lib/modelCatalog';

/**
 * A `<provider>/<model-id>` field that suggests the model catalog's models of
 * `kind`, each with its price, and still accepts a spec the catalog lacks — a
 * model released today, or a self-hosted endpoint. Saving one returns a
 * catalog warning; it is never refused.
 */
export function ModelSpecPicker({
  kind,
  value,
  onChange,
  label,
  hint,
  placeholder = '<provider>/<model-id>',
  required,
  id,
}: {
  kind: ModelKind;
  value: string;
  onChange: (spec: string) => void;
  label?: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  id?: string;
}) {
  const { data } = useModelCatalog({ kind });
  return (
    <Combobox
      allowsCustomValue
      className="font-mono text-xs"
      emptyMessage="Not in the model catalog — its calls would be recorded at $0."
      hint={hint}
      id={id}
      label={label}
      onChange={onChange}
      options={modelSpecOptions(data ?? [])}
      placeholder={placeholder}
      required={required}
      value={value}
    />
  );
}
