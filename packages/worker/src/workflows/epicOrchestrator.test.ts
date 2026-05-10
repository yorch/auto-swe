import type { EpicRepoEntry } from '@auto-swe/shared/types/workflow';
import { describe, expect, it } from 'vitest';
import { computeTransitiveDependents } from './epicOrchestrator.js';

describe('computeTransitiveDependents', () => {
  it('returns empty set when no repo depends on the failed one', () => {
    const repos: EpicRepoEntry[] = [
      { dependsOn: [], repoId: 'A' },
      { dependsOn: [], repoId: 'B' },
    ];
    expect(computeTransitiveDependents('A', repos)).toEqual(new Set());
  });

  it('finds direct dependents', () => {
    const repos: EpicRepoEntry[] = [
      { dependsOn: [], repoId: 'A' },
      { dependsOn: ['A'], repoId: 'B' },
      { dependsOn: ['A'], repoId: 'C' },
    ];
    expect(computeTransitiveDependents('A', repos)).toEqual(new Set(['B', 'C']));
  });

  it('walks transitively (chain A → B → C → D)', () => {
    const repos: EpicRepoEntry[] = [
      { dependsOn: [], repoId: 'A' },
      { dependsOn: ['A'], repoId: 'B' },
      { dependsOn: ['B'], repoId: 'C' },
      { dependsOn: ['C'], repoId: 'D' },
    ];
    expect(computeTransitiveDependents('A', repos)).toEqual(new Set(['B', 'C', 'D']));
  });

  it('handles diamond dependency graph', () => {
    // A → B, A → C, both B and C → D
    const repos: EpicRepoEntry[] = [
      { dependsOn: [], repoId: 'A' },
      { dependsOn: ['A'], repoId: 'B' },
      { dependsOn: ['A'], repoId: 'C' },
      { dependsOn: ['B', 'C'], repoId: 'D' },
    ];
    expect(computeTransitiveDependents('A', repos)).toEqual(new Set(['B', 'C', 'D']));
  });

  it('does not include the failed repo itself', () => {
    const repos: EpicRepoEntry[] = [
      { dependsOn: [], repoId: 'A' },
      { dependsOn: ['A'], repoId: 'B' },
    ];
    expect(computeTransitiveDependents('A', repos)).not.toContain('A');
  });

  it('does not loop forever on cyclic dependencies', () => {
    // Pathological input: B → A → B. Real plans should be DAGs but the walk
    // must still terminate.
    const repos: EpicRepoEntry[] = [
      { dependsOn: ['B'], repoId: 'A' },
      { dependsOn: ['A'], repoId: 'B' },
    ];
    expect(computeTransitiveDependents('A', repos)).toEqual(new Set(['B', 'A']));
  });

  it('treats failed leaf node correctly (no dependents)', () => {
    const repos: EpicRepoEntry[] = [
      { dependsOn: [], repoId: 'A' },
      { dependsOn: ['A'], repoId: 'B' },
    ];
    expect(computeTransitiveDependents('B', repos)).toEqual(new Set());
  });

  it('handles repos referenced as deps but not present in the array', () => {
    // E.g. caller passed only a subset of the epic's repos. Should not throw.
    const repos: EpicRepoEntry[] = [{ dependsOn: ['MISSING'], repoId: 'A' }];
    expect(() => computeTransitiveDependents('MISSING', repos)).not.toThrow();
    expect(computeTransitiveDependents('MISSING', repos)).toEqual(new Set(['A']));
  });
});
