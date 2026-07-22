'use client';

import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useEffect, useState } from 'react';

// Factors out the repeated "load query -> seed local form state -> submit ->
// saved/error" cycle shared by the workflow config forms (consolidation,
// revalidation, canary, workflow defaults). The consumer still owns
// `isLoading`/`isPending` (from its own query/mutation) and any non-form
// state (e.g. a "trigger now" button's local pending flag).

export interface UseConfigFormOptions<TData, TForm, TBody> {
  /** The query result (`undefined` until it loads). */
  data: TData | undefined;
  /** Form state to use before `data` has arrived. */
  initial: TForm;
  /** Maps the loaded query data to form state — runs once `data` arrives. */
  toForm: (data: TData) => TForm;
  /** Maps form state to the mutation request body at submit time. */
  toBody: (form: TForm) => TBody;
  /** The mutation's `mutateAsync`, called with the body built by `toBody`. */
  mutateAsync: (body: TBody) => Promise<unknown>;
}

export interface UseConfigFormResult<TForm> {
  form: TForm;
  setForm: Dispatch<SetStateAction<TForm>>;
  setField: <K extends keyof TForm>(key: K, value: TForm[K]) => void;
  submit: (e?: FormEvent) => Promise<void>;
  saved: boolean;
  error: string | null;
}

export function useConfigForm<TData, TForm, TBody>(
  opts: UseConfigFormOptions<TData, TForm, TBody>
): UseConfigFormResult<TForm> {
  const { data, initial, toForm, toBody, mutateAsync } = opts;

  const [form, setForm] = useState<TForm>(initial);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: toForm is a pure mapping supplied by the caller; re-seeding should only be driven by the query data itself, not by a new (often inline) function identity.
  useEffect(() => {
    if (data) {
      setForm(toForm(data));
    }
  }, [data]);

  const setField = <K extends keyof TForm>(key: K, value: TForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await mutateAsync(toBody(form));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return { error, form, saved, setField, setForm, submit };
}
