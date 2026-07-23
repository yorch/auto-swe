'use client';

import { useState } from 'react';

/** Narrow an unknown thrown value to a message string. Shared by every tab. */
export function errMsg(err: unknown, fallback = 'Request failed'): string {
  return err instanceof Error ? err.message : fallback;
}

/** The `{ ok, detail }` shape every `test<X>Connection()` helper resolves to. */
export interface TestResult {
  ok: boolean;
  detail: string;
}

/**
 * Some config mutations return `{ data: { …, requiresRestart? } }` (GitHub /
 * Slack / OAuth — creds read once at gateway boot). Read it defensively so the
 * same helper works for the mutations that don't carry the flag (it stays
 * `false`, and those tabs never render the restart banner anyway).
 */
function extractRequiresRestart(result: unknown): boolean {
  return !!(result as { data?: { requiresRestart?: boolean } } | null)?.data?.requiresRestart;
}

export interface UseIntegrationConfigFormResult {
  saved: boolean;
  error: string | null;
  requiresRestart: boolean;
  testing: boolean;
  testResult: TestResult | null;
  /**
   * Run a save. Resets the status flags, awaits `run()` (the caller's
   * `update.mutateAsync(body)`), then sets `saved` + captures `requiresRestart`
   * from the result and calls `onSuccess` (where the tab clears its secret
   * inputs). A throw is surfaced via `error`.
   */
  submit: <T>(run: () => Promise<T>, onSuccess?: (result: T) => void) => Promise<void>;
  /**
   * Run a test-connection. Toggles `testing` and stores the `{ ok, detail }`
   * result (a throw becomes `{ ok: false, detail: <message> }`).
   */
  runTest: (run: () => Promise<TestResult>) => Promise<void>;
}

/**
 * Shared state + runners for the integration admin tabs (GitHub, Slack, Storage,
 * Tracker, Knowledge Base, Figma, OAuth). These forms are **write-only for
 * secrets** — the read returns masked values, so the inputs stay
 * caller-owned (blank = "keep current") and are NOT seeded here; this hook only
 * factors out the identical save/test lifecycle (`saved`/`error`/`testing`/
 * `testResult`/`requiresRestart` + the two try/catch runners) that each tab
 * previously hand-rolled. Body-building and secret-clearing stay in the tab.
 */
export function useIntegrationConfigForm(): UseIntegrationConfigFormResult {
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const submit = async <T>(run: () => Promise<T>, onSuccess?: (result: T) => void) => {
    setError(null);
    setSaved(false);
    setRequiresRestart(false);
    setTestResult(null);
    try {
      const result = await run();
      setSaved(true);
      setRequiresRestart(extractRequiresRestart(result));
      onSuccess?.(result);
    } catch (err) {
      setError(errMsg(err, 'Failed to save'));
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

  return { error, requiresRestart, runTest, saved, submit, testing, testResult };
}
