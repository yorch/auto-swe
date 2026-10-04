'use client';

import { type Dispatch, type SetStateAction, useCallback, useMemo, useState } from 'react';

/**
 * The keys whose value differs between `current` and `baseline`. Compared by
 * JSON so a list or nested object counts as changed only when its contents do.
 */
export function changedKeys<T extends object>(current: T, baseline: T): (keyof T)[] {
  return (Object.keys(current) as (keyof T)[]).filter(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(baseline[key])
  );
}

export interface UseFormStateResult<T extends object> {
  form: T;
  /** Replace the form, clearing the saved / error state: an edit supersedes both. */
  setForm: Dispatch<SetStateAction<T>>;
  setField: <K extends keyof T>(key: K, value: T[K]) => void;
  /** The last loaded or saved values — what "unsaved" is measured against. */
  baseline: T;
  changed: (keyof T)[];
  dirtyCount: number;
  isDirty: boolean;
  saved: boolean;
  error: string | null;
  /** Load values from the server: the form and its baseline both become `values`. */
  seed: (values: T) => void;
  /** The submitted values are now what the server holds. */
  markSaved: (values: T) => void;
  markFailed: (message: string) => void;
  /** Drop every unsaved edit. */
  discard: () => void;
  /** Forget a stale saved / error line without touching the form. */
  clearStatus: () => void;
}

/**
 * Local state for an edit-then-save form: the values, what they were when last
 * loaded or saved (so the form knows how many fields are unsaved), and a
 * saved / error status that clears as soon as the person edits again. Pair it
 * with `useUnsavedChangesGuard` to warn before leaving with edits.
 */
export function useFormState<T extends object>(initial: T): UseFormStateResult<T> {
  const [form, setFormRaw] = useState<T>(initial);
  const [baseline, setBaseline] = useState<T>(initial);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearStatus = useCallback(() => {
    setSaved(false);
    setError(null);
  }, []);

  const setForm: Dispatch<SetStateAction<T>> = useCallback(
    (next) => {
      setFormRaw(next);
      clearStatus();
    },
    [clearStatus]
  );

  const setField = useCallback(
    <K extends keyof T>(key: K, value: T[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
    },
    [setForm]
  );

  const seed = useCallback((values: T) => {
    setFormRaw(values);
    setBaseline(values);
  }, []);

  const markSaved = useCallback((values: T) => {
    setBaseline(values);
    setError(null);
    setSaved(true);
  }, []);

  const markFailed = useCallback((message: string) => {
    setSaved(false);
    setError(message);
  }, []);

  const discard = useCallback(() => {
    setFormRaw(baseline);
    clearStatus();
  }, [baseline, clearStatus]);

  const changed = useMemo(() => changedKeys(form, baseline), [form, baseline]);

  return {
    baseline,
    changed,
    clearStatus,
    dirtyCount: changed.length,
    discard,
    error,
    form,
    isDirty: changed.length > 0,
    markFailed,
    markSaved,
    saved,
    seed,
    setField,
    setForm,
  };
}
