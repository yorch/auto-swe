import { describe, expect, it } from 'vitest';
import { failingStepRuns, normaliseRunCommand } from './ciWorkflowFile.js';

const FILE = `
jobs:
  test:
    name: Unit
    strategy:
      matrix: { node: [18, 20] }
    steps:
      - uses: actions/checkout@v4
      - name: Tests
        run: |
          yarn install
          yarn test
      - run: yarn lint
  release:
    steps:
      - name: Tests
        run: npm publish
`;

describe('failingStepRuns', () => {
  it('returns the run of each failed step of each failed job, matrix legs included', () => {
    expect(
      failingStepRuns(FILE, [{ failedSteps: ['Tests', 'Run yarn lint'], name: 'Unit (18)' }])
    ).toEqual(['yarn install\nyarn test', 'yarn lint']);
  });

  it('never returns a step of a job that did not fail, even with the same step name', () => {
    expect(failingStepRuns(FILE, [{ failedSteps: ['Tests'], name: 'Unit' }])).not.toContain(
      'npm publish'
    );
  });

  it('is empty for a file that does not parse, or names no such step', () => {
    expect(failingStepRuns('jobs: [', [{ failedSteps: ['Tests'], name: 'Unit' }])).toEqual([]);
    expect(failingStepRuns(FILE, [])).toEqual([]);
  });

  it('normalises indentation and blank lines', () => {
    expect(normaliseRunCommand('  a\n\n   b  \n')).toBe('a\nb');
  });
});
