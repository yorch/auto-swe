import { AsyncLocalStorage } from '@temporalio/workflow';
import type { NodeTag } from './nodeTag.js';

/**
 * The node whose activity the workflow is scheduling right now.
 *
 * AsyncLocalStorage, not a module variable: a fan-out runs several branches
 * concurrently and each awaits between choosing its node and scheduling its
 * activity, so a shared slot would hand one branch's tag to another's activity.
 * The store follows the async chain, so each dispatch sees exactly its own.
 */
const nodeTagStorage = new AsyncLocalStorage<NodeTag>();

export function runWithNodeTag<T>(tag: NodeTag | undefined, body: () => T): T {
  return tag ? nodeTagStorage.run(tag, body) : body();
}

export function currentNodeTag(): NodeTag | undefined {
  return nodeTagStorage.getStore();
}
