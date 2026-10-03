import { resolveTemporalAddress } from '@auto-swe/shared/lib/systemConfig';
import { traceContextClientInterceptor } from '@auto-swe/shared/lib/temporalTracing';
import { Client, Connection } from '@temporalio/client';

let _client: Client | undefined;

/**
 * Called once at worker startup (worker/src/index.ts) so the client is ready
 * before any activity runs. Uses a dedicated @temporalio/client Connection
 * because NativeConnection (used for the Temporal poller) is not compatible
 * with Client — they are distinct transport types in the Temporal SDK.
 */
export async function initTemporalClient(): Promise<void> {
  const connection = await Connection.connect({
    address: resolveTemporalAddress(),
  });
  // A run an activity starts (a PRD's child runs) joins that activity's trace.
  _client = new Client({
    connection,
    interceptors: { workflow: [traceContextClientInterceptor()] },
  });
}

/**
 * Returns the Temporal Client initialized at startup. Throws if called before
 * initTemporalClient().
 */
export function getTemporalClient(): Client {
  if (!_client) {
    throw new Error('Temporal client not initialized — call initTemporalClient() at startup');
  }
  return _client;
}
