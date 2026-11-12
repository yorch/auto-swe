import { setTimeout as delay } from 'node:timers/promises';
import { config } from './config.ts';
import { Broker, UpstreamError } from './server.ts';

const broker = new Broker(config());
const stopping = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopping.abort();
    broker.server.close();
    broker.server.closeAllConnections();
  });
}
let backoff = 250;
while (!stopping.signal.aborted) {
  try {
    await broker.initialize();
    break;
  } catch (error) {
    if (!(error instanceof UpstreamError) || !error.retryable) {
      throw error;
    }
    console.error(`${error.message}; retry in ${backoff}ms`);
    await delay(backoff, undefined, { signal: stopping.signal }).catch(() => {});
    backoff = Math.min(backoff * 2, 30_000);
  }
}
if (!stopping.signal.aborted) {
  broker.server.listen(Number(process.env.PORT ?? 2375), '0.0.0.0', () =>
    console.info('Docker policy broker ready')
  );
}
