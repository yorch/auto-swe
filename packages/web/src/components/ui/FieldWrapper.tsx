import type { ReactNode } from 'react';

interface FieldWrapperProps {
  id?: string;
  label?: string;
  hint?: string;
  error?: string;
  /** Shows the `*` marker. The native `required` attribute stays on the control itself. */
  required?: boolean;
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

/** The required marker. Hidden from assistive tech, which gets the native `required` instead. */
export function RequiredMark() {
  return (
    <span aria-hidden="true" className="text-brick-400">
      {' '}
      *
    </span>
  );
}

export function FieldWrapper({ id, label, hint, error, required, children }: FieldWrapperProps) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label className="label-mono block" htmlFor={id}>
          {label}
          {required && <RequiredMark />}
        </label>
      )}
      {children}
      {hint && !error && (
        <p className="text-xs text-paper-500" id={id ? `${id}-hint` : undefined}>
          {hint}
        </p>
      )}
      {error && (
        <p className="text-xs text-brick-400" id={id ? `${id}-error` : undefined}>
          {error}
        </p>
      )}
    </div>
  );
}
