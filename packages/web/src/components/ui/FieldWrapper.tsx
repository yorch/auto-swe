import type { ReactNode } from 'react';

interface FieldWrapperProps {
  id?: string;
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

/**
 * The `aria-describedby` value for a field wrapped by `FieldWrapper`, matching
 * the ids it gives the hint and error nodes. Kept here so the three field
 * primitives cannot drift from the markup that provides those ids.
 */
export function fieldDescribedBy(
  id: string | undefined,
  hint: string | undefined,
  error: string | undefined
): string | undefined {
  if (!id) {
    return undefined;
  }
  return (
    [hint && !error ? `${id}-hint` : null, error ? `${id}-error` : null]
      .filter(Boolean)
      .join(' ') || undefined
  );
}

export function FieldWrapper({ id, label, hint, error, children }: FieldWrapperProps) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label
          className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
          htmlFor={id}
        >
          {label}
        </label>
      )}
      {children}
      {hint && !error && (
        <p
          className="font-mono text-[10px] uppercase tracking-wider text-paper-500"
          id={id ? `${id}-hint` : undefined}
        >
          {hint}
        </p>
      )}
      {error && (
        <p
          className="font-mono text-[10px] uppercase tracking-wider text-brick-400"
          id={id ? `${id}-error` : undefined}
        >
          {error}
        </p>
      )}
    </div>
  );
}
