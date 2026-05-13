/**
 * Example spec — user-authored shell step gated behind quality checks.
 *
 * Demonstrates the phase-6 `shell` node type: a custom SBOM-upload step that
 * runs in a locked-down ephemeral container after the build passes. The
 * command itself is illustrative — it dumps the Yarn lockfile through `cat`
 * and pipes a fixed string to a hypothetical upload URL.
 *
 * Authoring this spec requires team-admin role (or platform ADMIN) on the
 * template's owning team; the `python:3.13-alpine` image is on the built-in
 * allowlist, so no per-team allowlist edit is required.
 */

import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

export const SHELL_STEP_EXAMPLE_SPEC: WorkflowSpec = {
  description:
    'Example workflow that implements + builds, then uploads an SBOM via a phase-6 shell step before opening the PR.',
  entry: 'implement',
  name: 'engineering-with-shell-sbom',
  nodes: {
    build: {
      next: 'checkBuild',
      onFail: 'block',
      step: 'runBuild',
      type: 'step',
    },
    checkBuild: {
      expr: 'nodes.build.output.passed == true',
      onFalse: 'failed',
      onTrue: 'uploadSbom',
      type: 'cond',
    },
    done: {
      result: { sbomCommit: { from: 'nodes.uploadSbom.output.committedSha' } },
      status: 'SUCCESS',
      type: 'terminate',
    },
    failed: {
      status: 'FAILED',
      type: 'terminate',
    },
    implement: {
      next: 'build',
      step: 'executeImplementation',
      type: 'step',
    },
    openPr: {
      next: 'done',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    // The phase-6 shell node. `onFail: 'warn'` so SBOM upload failures
    // don't block the PR — the artifact is still captured for triage.
    uploadSbom: {
      command:
        'python -c "import json; print(json.dumps({\\"ok\\": True}))" > /workspace/sbom.json',
      cpus: 1,
      image: 'python:3.13-alpine',
      memory: '512m',
      network: 'none',
      next: 'openPr',
      onFail: 'warn',
      timeoutMs: 120_000,
      type: 'shell',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
