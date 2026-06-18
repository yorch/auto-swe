import { Client, Connection } from '@temporalio/client';

let _client: Client | undefined;

/**
 * Lazy-init singleton Temporal Client for use in worker activities that need
 * to start child workflows (e.g. `submitPrdWorkRequests`). The worker process
 * creates a `NativeConnection` for the Temporal poller but no `Client`; this
 * module fills that gap on first call and reuses the connection for subsequent
 * calls so we never open more than one connection per worker process.
 */
export async function getTemporalClient(): Promise<Client> {
  if (!_client) {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    });
    _client = new Client({ connection });
  }
  return _client;
}
