'use client';

import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ScannerTestResult {
  index: number;
  matched: boolean;
  /** The first match only: the executor reports one match per sample. */
  match: { excerpt: string; length: number; truncated: boolean } | null;
  status: 'matched' | 'no_match' | 'timed_out' | 'error' | 'not_run';
}

export interface ScannerTestResponse {
  budgetMs: number;
  /** Executor time after which the remaining samples are reported as not run. */
  totalCapMs?: number;
  results: ScannerTestResult[];
}

/** Dry-runs a pattern against sample text on the gateway. Writes nothing. */
export function useTestScannerPattern() {
  return useMutation({
    mutationFn: (body: { flags: string; pattern: string; samples: string[] }) =>
      api
        .post<{ data: ScannerTestResponse }>('/api/v1/platform/scanner-patterns/test', body)
        .then((r) => r.data),
  });
}
