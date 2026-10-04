'use client';

import type { FormEvent } from 'react';
import { useEffect, useRef } from 'react';
import { errMsg } from '@/lib/errors';
import { type UseFormStateResult, useFormState } from './useFormState';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

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

export interface UseConfigFormResult<TForm extends object> extends UseFormStateResult<TForm> {
  submit: (e?: FormEvent) => Promise<void>;
}

export function useConfigForm<TData, TForm extends object, TBody>(
  opts: UseConfigFormOptions<TData, TForm, TBody>
): UseConfigFormResult<TForm> {
  const { data, initial, toForm, toBody, mutateAsync } = opts;

  const state = useFormState<TForm>(initial);
  const { form, seed, markSaved, markFailed, clearStatus } = state;
  // A form with unsaved edits warns before the page is left.
  useUnsavedChangesGuard(state.isDirty);

  // Seed the form from the query data exactly ONCE, on its first arrival. A
  // later background refetch (staleTime + refetchOnWindowFocus) hands back a new
  // `data` reference; re-seeding on that would clobber the admin's in-progress
  // edits, so we guard with a ref. The form is user-owned after the first seed.
  const seededRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: toForm is a pure mapping supplied by the caller; seeding is driven only by the query data's first arrival, not by a new (often inline) function identity.
  useEffect(() => {
    if (data && !seededRef.current) {
      seededRef.current = true;
      seed(toForm(data));
    }
  }, [data]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    clearStatus();
    const submitted = form;
    try {
      await mutateAsync(toBody(submitted));
      markSaved(submitted);
    } catch (err) {
      markFailed(errMsg(err, 'Failed to save'));
    }
  };

  return { ...state, submit };
}
