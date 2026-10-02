import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ActivityInboundCallsInterceptor,
  type ActivityInterceptors,
  defaultPayloadConverter,
} from '@temporalio/worker';
import { NODE_TAG_HEADER, type NodeTag, parseNodeTag } from '../workflows/nodeTag.js';

const storage = new AsyncLocalStorage<NodeTag>();

/**
 * The spec node the running activity was dispatched for, or undefined when it
 * was not dispatched by the interpreter (or the worker's workflow bundle was not
 * built with the node-tag interceptor).
 */
export function currentNodeTag(): NodeTag | undefined {
  return storage.getStore();
}

/** Run `body` as if an activity had been dispatched for `tag`. */
export function runWithActivityNodeTag<T>(tag: NodeTag, body: () => T): T {
  return storage.run(tag, body);
}

/** The `AgentTrace` columns that attribute a row to its spec node. */
export function nodeTagColumns(tag: NodeTag | undefined): {
  recordingId: string | null;
  specNodeId: string | null;
  stepAttempt: number | null;
} {
  return {
    recordingId: tag?.recordingId ?? null,
    specNodeId: tag?.specNodeId ?? null,
    stepAttempt: tag?.stepAttempt ?? null,
  };
}

function decode(headers: Record<string, unknown> | undefined): NodeTag | undefined {
  const raw = headers?.[NODE_TAG_HEADER];
  if (!raw) {
    return undefined;
  }
  try {
    return parseNodeTag(defaultPayloadConverter.fromPayload(raw as never));
  } catch {
    // A header this worker cannot decode only costs attribution, never the run.
    return undefined;
  }
}

/** Makes the header the workflow stamped on this dispatch readable from the activity body. */
export function activityNodeTagInterceptor(): ActivityInterceptors {
  const inbound: ActivityInboundCallsInterceptor = {
    execute(input, next) {
      const tag = decode(input.headers);
      return tag ? storage.run(tag, () => next(input)) : next(input);
    },
  };
  return { inbound };
}
