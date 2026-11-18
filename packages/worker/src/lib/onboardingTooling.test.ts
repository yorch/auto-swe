import { RepoOnboardingDraftSchema } from '@auto-swe/shared/lib/onboardingPr';
import { describe, expect, it } from 'vitest';
import { relaxDraftToolChecks, relaxOptionalToolChecks } from './onboardingTooling.js';

describe('relaxOptionalToolChecks', () => {
  it('makes bare presence checks for tools the workspace may lack non-fatal', () => {
    const run = [
      'command -v docker',
      'command -v helm >/dev/null 2>&1',
      'command -v snyk || true',
    ].join('\n');
    expect(relaxOptionalToolChecks(run).split('\n')).toEqual([
      'command -v docker || echo "warning: docker not found in this workspace; continuing"',
      'command -v helm >/dev/null 2>&1 || echo "warning: helm not found in this workspace; continuing"',
      'command -v snyk || true',
    ]);
  });

  it('keeps checks for tools the setup needs, and commands that do real work', () => {
    const run = [
      'command -v node',
      'which yarn',
      'command -v docker && docker info',
      'yarn install',
    ].join('\n');
    expect(relaxOptionalToolChecks(run)).toBe(run);
  });

  it('preserves indentation and handles empty input', () => {
    expect(relaxOptionalToolChecks('  which kubectl')).toBe(
      '  which kubectl || echo "warning: kubectl not found in this workspace; continuing"'
    );
    expect(relaxOptionalToolChecks('')).toBe('');
  });
});

describe('relaxDraftToolChecks', () => {
  it('rewrites the tooling step of a draft and leaves a draft without steps untouched', () => {
    const draft = RepoOnboardingDraftSchema.parse({
      gateCommands: {},
      setup: {
        steps: [
          { name: 'Verify required local tooling', run: 'command -v docker\ncommand -v helm' },
          { name: 'install', run: 'yarn install' },
        ],
      },
    });
    const relaxed = relaxDraftToolChecks(draft);
    expect(relaxed.setup.steps?.[0]?.run).toContain('docker || echo');
    expect(relaxed.setup.steps?.[0]?.run).toContain('helm || echo');
    expect(relaxed.setup.steps?.[1]).toEqual(draft.setup.steps?.[1]);

    const empty = RepoOnboardingDraftSchema.parse({ gateCommands: {}, setup: {} });
    expect(relaxDraftToolChecks(empty)).toBe(empty);
  });
});
