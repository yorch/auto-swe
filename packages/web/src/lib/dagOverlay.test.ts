import { describe, expect, it } from 'vitest';
import { buildDagOverlay, specNodeIdOf } from './dagOverlay';

describe('buildDagOverlay', () => {
  it('lets the latest attempt of one node supersede the earlier one', () => {
    const { byNodeId } = buildDagOverlay([
      { attempt: 1, nodeId: 'lint', status: 'FAILED' },
      { attempt: 2, nodeId: 'lint', status: 'PASSED' },
    ]);
    expect(byNodeId.lint).toEqual({ attempt: 2, status: 'PASSED' });
  });

  it('keeps a failed fan-out branch visible when a later sibling passes', () => {
    const { byNodeId } = buildDagOverlay([
      { attempt: 1, nodeId: 'fan[0]/impl', status: 'FAILED' },
      { attempt: 1, nodeId: 'fan[1]/impl', status: 'PASSED' },
      { attempt: 1, nodeId: 'fan[2]/impl', status: 'PASSED' },
    ]);
    expect(byNodeId.impl?.status).toBe('FAILED');
  });

  it('does not let a retried branch hide behind its own earlier failure', () => {
    const { byNodeId } = buildDagOverlay([
      { attempt: 1, nodeId: 'fan[0]/impl', status: 'FAILED' },
      { attempt: 2, nodeId: 'fan[0]/impl', status: 'PASSED' },
      { attempt: 1, nodeId: 'fan[1]/impl', status: 'PASSED' },
    ]);
    expect(byNodeId.impl?.status).toBe('PASSED');
  });

  it('shows a running branch over passed ones', () => {
    const { byNodeId } = buildDagOverlay([
      { attempt: 1, nodeId: 'fan[0]/impl', status: 'PASSED' },
      { attempt: 1, nodeId: 'fan[1]/impl', status: 'RUNNING' },
    ]);
    expect(byNodeId.impl?.status).toBe('RUNNING');
  });

  it('maps nested branch ids to the spec node', () => {
    expect(specNodeIdOf('outer[1]/inner[0]/leaf')).toBe('leaf');
    expect(specNodeIdOf('plain')).toBe('plain');
  });
});
