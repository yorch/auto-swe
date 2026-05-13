import { describe, expect, it } from 'vitest';
import { parseWorkflowSpec } from '../spec.js';
import { SHELL_STEP_EXAMPLE_SPEC } from './shellStep.spec.js';

describe('SHELL_STEP_EXAMPLE_SPEC', () => {
  it('parses and validates', () => {
    expect(() => parseWorkflowSpec(SHELL_STEP_EXAMPLE_SPEC)).not.toThrow();
  });

  it('uses an image from the built-in allowlist', () => {
    const uploadSbom = SHELL_STEP_EXAMPLE_SPEC.nodes.uploadSbom;
    expect(uploadSbom?.type).toBe('shell');
    if (uploadSbom?.type === 'shell') {
      expect(['node:24-alpine', 'python:3.13-alpine', 'alpine:latest']).toContain(uploadSbom.image);
    }
  });

  it('uses onFail:warn so a non-fatal upload failure does not block the PR', () => {
    const uploadSbom = SHELL_STEP_EXAMPLE_SPEC.nodes.uploadSbom;
    if (uploadSbom?.type === 'shell') {
      expect(uploadSbom.onFail).toBe('warn');
    }
  });
});
