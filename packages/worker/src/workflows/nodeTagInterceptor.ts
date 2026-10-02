import { defaultPayloadConverter, type WorkflowInterceptors } from '@temporalio/workflow';
import { NODE_TAG_HEADER } from './nodeTag.js';
import { currentNodeTag } from './nodeTagScope.js';

/**
 * Workflow interceptor: stamp every activity the interpreter dispatches with the
 * node it runs for. Registered through `interceptors.workflowModules`, which is
 * the only way to run code on the scheduling path.
 *
 * Adds a header and nothing else, so the command stream (type, order, arguments)
 * is exactly what it was. An activity scheduled outside a dispatch (state
 * bookkeeping, `finalizeWorkflowRun`) gets no header.
 */
export const interceptors = (): WorkflowInterceptors => ({
  outbound: [
    {
      scheduleActivity(input, next) {
        const tag = currentNodeTag();
        if (!tag) {
          return next(input);
        }
        return next({
          ...input,
          headers: { ...input.headers, [NODE_TAG_HEADER]: defaultPayloadConverter.toPayload(tag) },
        });
      },
    },
  ],
});
