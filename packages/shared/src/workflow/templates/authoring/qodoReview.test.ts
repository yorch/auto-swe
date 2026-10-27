import { describe, expect, it } from 'vitest';
import { evalBoolean } from '../../expr.js';
import { qodoReview } from './qodoReview.js';
import { checkFragment, expectWellFormed } from './testUtil.js';

describe('qodoReview', () => {
  it('reads the recorded pull request, then routes on blocking', () => {
    const nodes = qodoReview({ next: 'waitForCI', onBlocked: 'qodoDecision' });
    expect(Object.keys(nodes).sort()).toEqual(['qodoGate', 'qodoReview']);
    expect(nodes.qodoReview).toMatchObject({
      inputs: {
        headSha: { from: 'context.currentCodeResult.headSha' },
        prUrl: { from: 'context.prUrl' },
      },
      next: 'qodoGate',
      step: 'awaitQodoReview',
    });
    expect(nodes.qodoGate).toMatchObject({
      expr: 'nodes.qodoReview.output.blocking == true',
      onFalse: 'waitForCI',
      onTrue: 'qodoDecision',
    });
    expectWellFormed(nodes, 'qodoReview', ['waitForCI', 'qodoDecision']);
  });

  it('names no connection or team anywhere', () => {
    expect(JSON.stringify(qodoReview({ next: 'n', onBlocked: 'b' }))).not.toMatch(
      /connection|team/i
    );
  });

  it('carries no node config unless asked', () => {
    expect(qodoReview({ next: 'n', onBlocked: 'b' }).qodoReview).not.toHaveProperty('config');
  });

  it('passes the wait and the lowest level through as config', () => {
    expect(
      qodoReview({ minActionLevel: 'action_required', next: 'n', onBlocked: 'b', waitSeconds: 0 })
        .qodoReview
    ).toMatchObject({ config: { minActionLevel: 'action_required', waitSeconds: 0 } });
  });

  describe('failClosed', () => {
    const gate = (over: { failClosed?: boolean } = {}) => {
      const nodes = qodoReview({ next: 'n', onBlocked: 'b', ...over });
      const node = nodes.qodoGate;
      return { expr: node && 'expr' in node ? node.expr : '', nodes };
    };
    const verdict = (expr: string, output: Record<string, unknown>) =>
      evalBoolean(expr, { nodes: { qodoReview: { output } } });

    it('keeps the fail-open gate by default', () => {
      const { expr } = gate();
      expect(expr).toBe('nodes.qodoReview.output.blocking == true');
      expect(verdict(expr, { blocking: false, status: 'unavailable' })).toBe(false);
      expect(gate({ failClosed: false }).expr).toBe(expr);
    });

    it('routes anything but a clean review of the head to onBlocked when set', () => {
      const { expr, nodes } = gate({ failClosed: true });
      for (const status of ['pending', 'stale', 'unavailable', 'disabled']) {
        expect(verdict(expr, { blocking: false, status })).toBe(true);
      }
      expect(verdict(expr, { blocking: true, status: 'reviewed' })).toBe(true);
      expect(verdict(expr, { blocking: false, status: 'reviewed' })).toBe(false);
      const { report } = checkFragment(nodes, 'qodoReview', ['n', 'b']);
      expect(report.errors ?? []).toEqual([]);
      expectWellFormed(nodes, 'qodoReview', ['n', 'b']);
    });
  });
});
