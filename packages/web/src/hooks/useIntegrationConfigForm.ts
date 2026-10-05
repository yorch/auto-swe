'use client';

import { useState } from 'react';
import { errMsg } from '@/lib/errors';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

/** The `{ ok, detail }` shape every `test<X>Connection()` helper resolves to. */
export interface TestResult {
  ok: boolean;
  detail: string;
  /** The test ran against values typed into the form but not yet saved. */
  unsaved?: boolean;
}

export interface UseIntegrationConfigFormResult {
  /** How many fields differ from what is saved. */
  dirtyCount: number;
  /** At least one field differs from what is saved. */
  isDirty: boolean;
  saved: boolean;
  /** True while `submit()`'s runner is in flight — disable the save button on it. */
  saving: boolean;
  error: string | null;
  testing: boolean;
  testResult: TestResult | null;
  /**
   * Run a save. Resets the status flags, awaits `run()` (the caller's
   * `update.mutateAsync(body)`), then sets `saved` and calls `onSuccess` (where
   * the tab clears its secret inputs). A throw is surfaced via `error`.
   */
  submit: <T>(run: () => Promise<T>, onSuccess?: (result: T) => void) => Promise<void>;
  /**
   * Run a test-connection. Toggles `testing` and stores the `{ ok, detail }`
   * result (a throw becomes `{ ok: false, detail: <message> }`).
   */
  runTest: (run: () => Promise<TestResult>) => Promise<void>;
}

/**
 * Shared state + runners for the integration admin tabs (GitHub, Slack,
 * Tracker, Knowledge Base, Figma). These forms are **write-only for
 * secrets** — the read returns masked values, so the inputs stay
 * caller-owned (blank = "keep current") and are NOT seeded here; this hook only
 * factors out the identical save/test lifecycle (`saved`/`error`/`testing`/
 * `testResult` + the two try/catch runners) that each tab
 * previously hand-rolled. A tab passes how many of its fields differ from the
 * saved config (`countChanges` of the body it would submit), which drives the
 * footer's Save state and the leave-page guard. Body-building and secret-clearing stay in the tab.
 */
export function useIntegrationConfigForm(dirtyCount = 0): UseIntegrationConfigFormResult {
  // Leaving the page (reload, close, in-app link) with edits asks first.
  useUnsavedChangesGuard(dirtyCount > 0);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const submit = async <T>(run: () => Promise<T>, onSuccess?: (result: T) => void) => {
    setError(null);
    setSaved(false);
    setTestResult(null);
    setSaving(true);
    try {
      const result = await run();
      setSaved(true);
      onSuccess?.(result);
    } catch (err) {
      setError(errMsg(err, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (run: () => Promise<TestResult>) => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await run());
    } catch (err) {
      setTestResult({ detail: errMsg(err), ok: false });
    } finally {
      setTesting(false);
    }
  };

  return {
    dirtyCount,
    error,
    isDirty: dirtyCount > 0,
    runTest,
    saved,
    saving,
    submit,
    testing,
    testResult,
  };
}
