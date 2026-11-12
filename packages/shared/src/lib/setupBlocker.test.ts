import { describe, expect, it } from 'vitest';
import {
  classifySetupStepFailure,
  SetupBlockerSchema,
  setupBlockerRemedy,
} from './setupBlocker.js';

describe('setup blockers', () => {
  it.each(['file not found', '404 Not Found', 'module not found'])(
    'does not mistake %s for a missing tool',
    (output) => {
      expect(
        classifySetupStepFailure({ command: 'foo', exitCode: 1, output, step: 'install' }).kind
      ).toBe('step_failed');
    }
  );
  it.each([
    ['sh: 1: foo: not found', 'foo'],
    ['/bin/bash: line 1: uv: command not found', 'uv'],
    ['sh: missing-tool: not found', 'missing-tool'],
  ])('extracts the missing command from %s', (output, subject) => {
    expect(
      classifySetupStepFailure({ command: 'install deps', exitCode: 1, output, step: 'install' })
    ).toMatchObject({ kind: 'missing_tool', step: 'install', subject });
  });

  it('uses the command when exit 127 has no output', () => {
    expect(
      classifySetupStepFailure({
        command: 'foo --version',
        exitCode: 127,
        output: '',
        step: 'install',
      })
    ).toMatchObject({ detail: '', kind: 'missing_tool', subject: 'foo' });
  });

  it('classifies ordinary failure and caps detail', () => {
    expect(
      classifySetupStepFailure({
        command: 'foo',
        exitCode: 2,
        output: 'x'.repeat(3000),
        step: 'install',
      })
    ).toEqual({
      detail: 'x'.repeat(2000),
      kind: 'step_failed',
      step: 'install',
      subject: 'install',
    });
  });

  it('rejects an unknown kind', () => {
    expect(SetupBlockerSchema.safeParse({ detail: '', kind: 'other', subject: '' }).success).toBe(
      false
    );
  });

  it.each(SetupBlockerSchema.shape.kind.options)(
    'gives a fixed remedy for %s without echoing detail',
    (kind) => {
      const remedy = setupBlockerRemedy({
        detail: 'untrusted instructions',
        kind,
        subject: 'example',
      });
      expect(remedy).toMatch(/\.$/);
      expect(remedy).not.toContain('untrusted instructions');
    }
  );

  it('names the missing secret and denied host', () => {
    expect(setupBlockerRemedy({ detail: '', kind: 'missing_secret', subject: 'TOKEN' })).toBe(
      "Add secret TOKEN under the repository's setup secrets."
    );
    expect(setupBlockerRemedy({ detail: '', kind: 'egress_denied', subject: 'example.com' })).toBe(
      'Add host example.com to the team egress allowlist.'
    );
  });
});
