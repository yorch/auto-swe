import type { Binding } from '../../spec.js';
import type { NodeMap } from './common.js';

export interface SourceHeadOptions {
  /** The workspace provider the run resolves (`document` for Notion pages, `record` for tickets). */
  provider: 'document' | 'record';
  /** What to read, beyond the connection (`{ pageId: … }` or `{ ticketId: … }`). */
  read: Record<string, Binding>;
  /** Node that follows the read. */
  next: string;
  /** Node `resolveWorkspace` hands over to. Default `readSource`; a template that branches first names it. */
  afterResolve?: string;
}

/**
 * The head of a non-code template: resolve the run's workspace from the
 * request's connection, then read the source record from it.
 * `resolveWorkspace -> readSource -> next`. Entry node: `resolveWorkspace`.
 */
export function sourceHead(opts: SourceHeadOptions): NodeMap {
  const group = 'read source';
  const connection: Binding = { from: 'request.payload.connectionId' };
  return {
    readSource: {
      config: {},
      group,
      inputs: { connectionId: connection, ...structuredClone(opts.read) },
      next: opts.next,
      step: 'readSource',
      title: 'Read the source',
      type: 'step',
    },
    resolveWorkspace: {
      config: { workspaceProvider: opts.provider },
      group,
      inputs: { connectionId: { ...connection } },
      next: opts.afterResolve ?? 'readSource',
      step: 'resolveWorkspace',
      title: 'Resolve the workspace',
      type: 'step',
    },
  };
}
