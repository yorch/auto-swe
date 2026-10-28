import { describe, expect, it } from 'vitest';
import { T_AGENT_RUN_ACTIVITY_SECONDS } from '../../workflows/proxyOptions.js';
import {
  DOCKER_WORKSPACE_CREATED_LABEL,
  DOCKER_WORKSPACE_MARKER_LABEL,
  DOCKER_WORKSPACE_MAX_AGE_MS,
  parseDockerListing,
  selectExpiredContainers,
  selectReapablePods,
  workspaceLabelArgs,
} from './orphans.js';

const NOW = new Date('2026-01-10T12:00:00Z');
const agoMs = (ms: number) => String(Math.floor((NOW.getTime() - ms) / 1000));
const HOUR = 3_600_000;

describe('workspaceLabelArgs', () => {
  it('marks the container as an auto-swe workspace and stamps its creation time', () => {
    expect(workspaceLabelArgs(NOW)).toEqual([
      '--label',
      `${DOCKER_WORKSPACE_MARKER_LABEL}=true`,
      '--label',
      `${DOCKER_WORKSPACE_CREATED_LABEL}=${Math.floor(NOW.getTime() / 1000)}`,
    ]);
  });
});

describe('DOCKER_WORKSPACE_MAX_AGE_MS', () => {
  it('outlasts the longest activity that can hold a workspace', () => {
    expect(DOCKER_WORKSPACE_MAX_AGE_MS).toBeGreaterThan(T_AGENT_RUN_ACTIVITY_SECONDS * 1000);
    expect(DOCKER_WORKSPACE_MAX_AGE_MS).toBeGreaterThan(4 * 3600 * 1000);
  });
});

describe('parseDockerListing', () => {
  it('reads id, name and the created-at label, skipping blank lines', () => {
    expect(parseDockerListing('abc|workspace-1|1700000000\n\nde|workspace-2|\n')).toEqual([
      { createdAtSec: 1_700_000_000, id: 'abc', name: 'workspace-1' },
      { createdAtSec: null, id: 'de', name: 'workspace-2' },
    ]);
  });
});

describe('selectExpiredContainers', () => {
  const row = (id: string, createdAtSec: number | null) => ({ createdAtSec, id, name: id });

  it('removes only containers older than the maximum lifetime', () => {
    const old = row('old', Number(agoMs(DOCKER_WORKSPACE_MAX_AGE_MS + HOUR)));
    const young = row('young-other-worker', Number(agoMs(HOUR)));
    const edge = row('just-inside', Number(agoMs(DOCKER_WORKSPACE_MAX_AGE_MS - 60_000)));
    expect(selectExpiredContainers([old, young, edge], NOW).map((c) => c.id)).toEqual(['old']);
  });

  it('keeps a container whose creation time is missing, malformed or in the future', () => {
    const future = row('future', Math.floor(NOW.getTime() / 1000) + 99_999);
    expect(selectExpiredContainers([row('none', null), row('zero', 0), future], NOW)).toEqual([]);
  });
});

describe('selectReapablePods', () => {
  const pod = (
    name: string,
    over: {
      phase?: string;
      ageMs?: number;
      deadline?: number | null;
      deleting?: boolean;
      labels?: Record<string, string>;
    } = {}
  ) => ({
    metadata: {
      creationTimestamp: new Date(NOW.getTime() - (over.ageMs ?? HOUR)).toISOString(),
      ...(over.deleting ? { deletionTimestamp: NOW.toISOString() } : {}),
      labels: over.labels ?? {
        'app.kubernetes.io/managed-by': 'auto-swe',
        'asw/role': 'workspace',
      },
      name,
    },
    spec: over.deadline === null ? {} : { activeDeadlineSeconds: over.deadline ?? 86_400 },
    status: { phase: over.phase ?? 'Running' },
  });
  const names = (items: ReturnType<typeof pod>[], fallback = 86_400) =>
    selectReapablePods(items, NOW, fallback).map((p) => p.metadata.name);

  it('removes terminated pods whatever their age, and keeps running ones within their deadline', () => {
    expect(
      names([
        pod('done', { phase: 'Succeeded' }),
        pod('killed', { ageMs: 1000, phase: 'Failed' }),
        pod('live', { phase: 'Running' }),
        pod('starting', { phase: 'Pending' }),
      ])
    ).toEqual(['done', 'killed']);
  });

  it('removes a pod still not terminated well past its deadline plus the grace period', () => {
    const day = 86_400 * 1000;
    expect(
      names([
        pod('stuck', { ageMs: day + 11 * 60_000 }),
        pod('within-grace', { ageMs: day + 5 * 60_000 }),
      ])
    ).toEqual(['stuck']);
  });

  it('uses the pod own deadline, and the configured one when the pod has none', () => {
    expect(names([pod('short', { ageMs: 2 * HOUR, deadline: 3600 })])).toEqual(['short']);
    expect(names([pod('nodeadline', { ageMs: 2 * HOUR, deadline: null })], 3600)).toEqual([
      'nodeadline',
    ]);
  });

  it('never selects a pod without both marker labels, or one already being deleted', () => {
    expect(
      names([
        pod('other-app', { labels: { app: 'x' }, phase: 'Failed' }),
        pod('half', { labels: { 'app.kubernetes.io/managed-by': 'auto-swe' }, phase: 'Failed' }),
        pod('going', { deleting: true, phase: 'Failed' }),
      ])
    ).toEqual([]);
  });
});

describe('workspaceLabelArgs marker', () => {
  it('is namespaced so no other tool on the host matches it', () => {
    expect(DOCKER_WORKSPACE_MARKER_LABEL).toMatch(/^auto-swe\./);
  });
});
