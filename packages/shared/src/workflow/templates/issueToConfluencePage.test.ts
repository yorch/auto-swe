import { describe, expect, it } from 'vitest';
import { type Node, WorkflowSpecSchema } from '../spec.js';
import { ISSUE_TO_CONFLUENCE_PAGE_SPEC } from './issueToConfluencePage.js';

const spec = ISSUE_TO_CONFLUENCE_PAGE_SPEC;
const nodes = spec.nodes as Record<string, Node & Record<string, unknown>>;

/** A node's resolved inputs as a plain lookup — the union type hides the index signature. */
const inputsOf = (id: string): Record<string, unknown> =>
  (nodes[id].inputs ?? {}) as Record<string, unknown>;

describe('ISSUE_TO_CONFLUENCE_PAGE_SPEC', () => {
  it('parses as a valid WorkflowSpec', () => {
    expect(WorkflowSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('reads the issue tracker on one connection and writes Confluence on another', () => {
    // The two-connection shape is the point: a run is scoped to the issue tracker,
    // and the page is written through a second connection the request names.
    expect(spec.entry).toBe('resolveWorkspace');
    expect(nodes.resolveWorkspace.inputs).toEqual({
      connectionId: { from: 'request.payload.connectionId' },
    });
    expect(nodes.resolveWorkspace.config).toEqual({ workspaceProvider: 'issue_tracker' });

    expect(nodes.readSource.inputs).toEqual({
      connectionId: { from: 'request.payload.connectionId' },
      issueId: { from: 'request.payload.issueId' },
    });

    for (const write of ['autoWrite', 'manualWrite']) {
      expect(nodes[write].inputs).toMatchObject({
        connectionId: { from: 'request.payload.docConnectionId' },
      });
    }
  });

  it('gates the write on the autonomy decision, with a person on the approval path', () => {
    expect(nodes.publishOutcome).toMatchObject({
      config: { action: 'external_write' },
      next: 'checkAuto',
      step: 'publishOutcome',
    });
    expect(nodes.checkAuto).toMatchObject({
      onFalse: 'autoWrite',
      onTrue: 'humanApproval',
      type: 'cond',
    });
    expect(nodes.humanApproval).toMatchObject({
      onApprove: 'manualWrite',
      onReject: 'doneRejected',
      onTimeout: 'doneRejected',
      type: 'humanApproval',
    });
    // A rejection must not leave the request-looking result claiming a write.
    expect(nodes.doneRejected).toMatchObject({
      result: { approved: { literal: false }, written: { literal: false } },
    });
  });

  it('reports the page the write produced', () => {
    expect(nodes.done).toMatchObject({
      result: {
        issueId: { from: 'request.payload.issueId' },
        pageUrl: {
          expr: 'nodes.autoWrite.output.reference ?? nodes.manualWrite.output.reference',
        },
      },
    });
  });

  it('titles a created page from the issue when the request names none', () => {
    // A form submits an untouched optional field as `''`, and no binding can say
    // "the first non-empty of these", so the write activity is given both and
    // chooses — otherwise a normal dashboard launch would fail for want of a title.
    for (const write of ['autoWrite', 'manualWrite']) {
      expect(inputsOf(write).title).toEqual({ from: 'request.payload.title' });
      expect(inputsOf(write).fallbackTitle).toEqual({
        from: 'nodes.readSource.output.data.title',
      });
      expect(inputsOf(write).title).not.toHaveProperty('expr');
    }
  });

  it('carries the caller-supplied version into the write', () => {
    // The declared `version` field is what makes a precondition protectable: a
    // supplied one is re-sent by every attempt, so a retry is refused as stale
    // rather than replacing an edit made while the draft was being approved.
    for (const write of ['autoWrite', 'manualWrite']) {
      expect(inputsOf(write).version).toEqual({ from: 'request.payload.version' });
    }
  });
});
