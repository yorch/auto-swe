import { initTelemetry } from './lib/telemetry.js';

/**
 * The OpenTelemetry preload. Started with `node --import ./dist/instrument.js`
 * (`tsx --import ./src/instrument.ts` in dev), so the SDK and its module hooks
 * are in place before `index.ts`'s import graph loads. Called from the entry
 * point instead, it would run after every static import had already bound
 * `http` and patch nothing.
 *
 * `index.ts` imports `otel` from here for its shutdown handle; the module is
 * evaluated once, so that import does not initialise a second SDK.
 */
export const otel = initTelemetry('auto-swe-worker');
