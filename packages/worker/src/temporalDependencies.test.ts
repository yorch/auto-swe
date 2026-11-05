import { readFileSync } from 'node:fs';
import { ApplicationFailure, CancelledFailure, TemporalFailure } from '@temporalio/common';
import * as workflow from '@temporalio/workflow';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
};

// These SDK packages are imported directly by worker source, not just by its dependencies.
const runtimePackages = [
  '@temporalio/activity',
  '@temporalio/client',
  '@temporalio/common',
  '@temporalio/worker',
  '@temporalio/workflow',
];

describe('worker Temporal dependency boundaries', () => {
  it.each(runtimePackages)('declares %s directly at the workflow SDK version', (name) => {
    expect(manifest.dependencies[name]).toBe(manifest.dependencies['@temporalio/workflow']);
  });

  it('pins the workflow SDK to an exact version', () => {
    expect(manifest.dependencies['@temporalio/workflow']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('preserves failure constructor identity through workflow SDK re-exports', () => {
    expect(workflow.ApplicationFailure).toBe(ApplicationFailure);
    expect(workflow.CancelledFailure).toBe(CancelledFailure);
    expect(workflow.TemporalFailure).toBe(TemporalFailure);
  });
});
