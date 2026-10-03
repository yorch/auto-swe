// An ESM app for instrument.test.ts: `http` is bound by a static import, the
// way every service module binds it. Prints the names of the spans exported.
import http from 'node:http';
import { trace } from '@opentelemetry/api';
import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

const server = http.createServer((_req, res) => res.end('ok')).listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const { port } = server.address() as { port: number };
await new Promise<void>((resolve) => {
  http.get({ path: '/probe', port }, (res) => {
    res.resume();
    res.on('end', () => resolve());
  });
});
server.close();

const provider = trace.getTracerProvider() as {
  getDelegate?: () => { forceFlush?: () => Promise<void> };
};
await provider.getDelegate?.().forceFlush?.();
const exporter = (globalThis as { __spanExporter?: InMemorySpanExporter }).__spanExporter;
const kinds = (exporter?.getFinishedSpans() ?? []).map((s) => s.kind);
console.log(JSON.stringify({ kinds }));
