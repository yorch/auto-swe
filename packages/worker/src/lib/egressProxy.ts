import { AsyncResource } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { prisma } from '@auto-swe/shared/db';
import { type GuardOptions, resolveAndCheck } from '@auto-swe/shared/lib/guardedDispatcher';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { metrics, trace } from '@opentelemetry/api';
import {
  currentActivityType,
  currentAttempt,
  currentTemporalRunId,
  currentWorkflowId,
  currentWorkflowRunId,
} from './activityContext.js';
import { logWarn } from './activityLog.js';
import { currentNodeTag, nodeTagColumns } from './activityNodeTag.js';
import { maskCredentialShapes } from './redactToken.js';
import { currentSpendOwner } from './spendOwner.js';
import { sanitizedPath } from './transcriptRecorder.js';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const failures = metrics.getMeter('auto-swe-worker').createCounter('egress_proxy.persist_failures');
type Row = NonNullable<Parameters<typeof prisma.workflowHttpCall.createMany>[0]>['data'];
type CallRow = Exclude<Row, Row[]>;
const normalHost = (host: string) =>
  host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');

export function egressHostAllowed(host: string, allowlist: readonly string[]): boolean {
  const name = normalHost(host);
  return (
    !allowlist.length ||
    allowlist.some((entry) => {
      const rule = normalHost(entry);
      return rule.startsWith('*.')
        ? name.endsWith(rule.slice(1)) && name !== rule.slice(2)
        : name === rule;
    })
  );
}

function cleanHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out = { ...headers };
  for (const key of [
    'connection',
    'proxy-authorization',
    'proxy-authenticate',
    'proxy-connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
    'trailer',
    'te',
    ...(headers.connection ?? '').split(',').map((v) => v.trim().toLowerCase()),
  ]) {
    delete out[key];
  }
  return out;
}

export interface EgressRegistration {
  url: string;
  token: string;
  release(): Promise<void>;
}

interface Exchange {
  stop(): void;
  done: Promise<void>;
}
interface Registration {
  run<T>(body: () => T): T;
  allowlist: string[];
  active: Set<Exchange>;
  released: boolean;
  write(row: Partial<CallRow>): Promise<void>;
  release(): Promise<void>;
}

export function createEgressProxy(options: {
  listenHost: string;
  listenPort: number;
  advertisedUrl: string | ((port: number) => string);
  guard?: GuardOptions;
  maxConcurrent?: number;
  idleTimeoutMs?: number;
  releaseTimeoutMs?: number;
}) {
  const registrations = new Map<string, Registration>();
  const idle = options.idleTimeoutMs ?? 60_000;
  const bound = options.releaseTimeoutMs ?? 5000;
  const authenticate = (req: http.IncomingMessage): Registration | undefined => {
    const header = req.headers['proxy-authorization'];
    if (typeof header !== 'string' || !/^Basic /i.test(header)) {
      return undefined;
    }
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    if (!decoded.startsWith('egress:')) {
      return undefined;
    }
    return registrations.get(digest(decoded.slice(7)));
  };

  function exchange(
    reg: Registration,
    req: http.IncomingMessage,
    client: Duplex,
    tunnel: boolean,
    response?: http.ServerResponse,
    head?: Buffer
  ): void {
    const startedAt = new Date();
    const start = performance.now();
    let upstream: net.Socket | http.ClientRequest | undefined;
    let completed = false;
    let requestBytes = 0;
    let responseBytes = 0;
    let status: number | undefined;
    let error: string | undefined;
    let target: URL | undefined;
    let targetPort: number | undefined;
    let blocked = false;
    let blockReason: string | undefined;
    let settle!: () => void;
    const work: Exchange = {
      done: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      stop: () => finish('registration released'),
    };
    const finish = (reason?: string) => {
      if (completed) {
        return;
      }
      completed = true;
      error ??= reason;
      upstream?.destroy();
      if (reason) {
        client.destroy();
      }
      void reg
        .write({
          blocked,
          blockReason,
          durationMs: Math.round(performance.now() - start),
          error: error ? maskCredentialShapes(error) : undefined,
          host: target ? normalHost(target.hostname) : '',
          id: randomUUID(),
          method: req.method ?? 'GET',
          path: tunnel ? '' : target ? sanitizedPath(target.href).path : '',
          port: targetPort,
          requestBytes,
          responseBytes,
          scheme: tunnel ? (targetPort === 443 ? 'https' : 'tcp') : 'http',
          startedAt,
          status,
        })
        .finally(() => {
          reg.active.delete(work);
          settle();
        });
    };
    const refuse = (code: number, reason: string, isBlocked = false) => {
      status = code;
      blocked = isBlocked;
      blockReason = isBlocked ? reason : undefined;
      if (tunnel) {
        client.end(`HTTP/1.1 ${code} Refused\r\nConnection: close\r\n\r\n`, () => client.destroy());
      } else {
        response?.writeHead(code, { connection: 'close' });
        response?.end('Egress proxy refused the request');
      }
      finish();
    };
    reg.active.add(work);
    client.once('error', () => finish('client socket error'));
    if (tunnel) {
      client.once('close', () => finish());
    } else {
      response?.once('close', () =>
        finish(response.writableFinished ? undefined : 'client closed')
      );
      req.once('aborted', () => finish('client aborted'));
    }
    void (async () => {
      try {
        if (reg.active.size > (options.maxConcurrent ?? 32)) {
          refuse(429, 'concurrent request limit');
          return;
        }
        const raw = req.url ?? '';
        if (tunnel && (!/^[^/?#@]+:\d+$/.test(raw) || raw.includes('\\'))) {
          refuse(400, 'invalid CONNECT target');
          return;
        }
        target = new URL(tunnel ? `http://${raw}` : raw);
        if (target.protocol !== 'http:' || target.username || target.password || target.hash) {
          refuse(400, 'invalid proxy target');
          return;
        }
        // URL normalizes the HTTP default port, but CONNECT's explicit port is authoritative.
        const port = tunnel
          ? Number(raw.slice(raw.lastIndexOf(':') + 1))
          : Number(target.port || 80);
        targetPort = port;
        if (!port || port > 65535) {
          refuse(400, 'invalid target port');
          return;
        }
        if (!egressHostAllowed(target.hostname, reg.allowlist)) {
          refuse(403, 'host is not in the team egress allowlist', true);
          return;
        }
        const addresses = await resolveAndCheck(target.hostname, options.guard);
        if (completed || reg.released) {
          finish('registration released');
          return;
        }
        const address = addresses[0];
        if (tunnel) {
          const socket = net.connect({ family: address.family, host: address.address, port });
          upstream = socket;
          socket.setTimeout(idle, () => finish('tunnel idle timeout'));
          socket.once('error', () => finish('upstream socket error'));
          socket.once('close', () => {
            client.end(() => client.destroy());
            finish();
          });
          socket.once('connect', () => {
            status = 200;
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head?.length) {
              requestBytes += head.length;
              socket.write(head);
            }
            client.on('data', (chunk: Buffer) => {
              requestBytes += chunk.length;
            });
            socket.on('data', (chunk: Buffer) => {
              responseBytes += chunk.length;
            });
            client.pipe(socket);
            socket.pipe(client);
          });
        } else {
          const headers = cleanHeaders(req.headers);
          headers.host = target.host;
          const request = http.request(
            {
              agent: false,
              family: address.family,
              headers,
              hostname: address.address,
              method: req.method,
              path: `${target.pathname}${target.search}`,
              port,
            },
            (res) => {
              status = res.statusCode;
              response?.writeHead(status ?? 502, cleanHeaders(res.headers));
              res.on('data', (chunk: Buffer) => {
                responseBytes += chunk.length;
              });
              res.once('error', () => finish('upstream response error'));
              res.once('aborted', () => finish('upstream response aborted'));
              if (response) {
                res.pipe(response);
                response.once('finish', () => finish());
              }
            }
          );
          upstream = request;
          request.setTimeout(idle, () => finish('upstream idle timeout'));
          request.once('error', () => {
            if (!completed) {
              error = 'upstream request error';
              refuse(502, error);
            }
          });
          req.on('data', (chunk: Buffer) => {
            requestBytes += chunk.length;
          });
          req.pipe(request);
        }
      } catch (err) {
        if (!completed) {
          error = maskCredentialShapes(String(err));
          refuse(403, 'target address was refused or could not be resolved', true);
        }
      }
    })();
  }

  const server = http.createServer((req, res) => {
    res.setHeader('connection', 'close');
    const reg = authenticate(req);
    if (!reg) {
      res.writeHead(407, { connection: 'close', 'proxy-authenticate': 'Basic realm="egress"' });
      res.end();
      return;
    }
    reg.run(() => exchange(reg, req, req.socket, false, res));
  });
  server.on('connect', (req, socket, head) => {
    socket.on('error', () => {});
    const reg = authenticate(req);
    if (!reg) {
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="egress"\r\nConnection: close\r\n\r\n',
        () => socket.destroy()
      );
      return;
    }
    reg.run(() => exchange(reg, req, socket, true, undefined, head));
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('error', () => logWarn('egress proxy server error'));
  let listening: Promise<number> | undefined;
  const listen = () =>
    (listening ??= new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.listenPort, options.listenHost, () => {
        server.off('error', reject);
        resolve((server.address() as net.AddressInfo).port);
      });
    }).catch((err: unknown) => {
      listening = undefined;
      throw err;
    }));

  return {
    async close() {
      await Promise.allSettled([...registrations.values()].map((reg) => reg.release()));
      if (listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    listen,
    async register(allowlist: string[]): Promise<EgressRegistration> {
      const port = await listen();
      const token = randomBytes(32).toString('hex');
      const key = digest(token);
      const span = trace.getActiveSpan()?.spanContext();
      const base = {
        ...nodeTagColumns(currentNodeTag()),
        ...(await currentSpendOwner()),
        activityType: currentActivityType(),
        attempt: currentAttempt(),
        otelSpanId: span?.spanId,
        otelTraceId: span?.traceId,
        purpose: 'egress',
        runId: await currentWorkflowRunId(),
        source: 'egress_proxy',
        temporalRunId: currentTemporalRunId(),
        workflowId: currentWorkflowId(),
      };
      let released: Promise<void> | undefined;
      const reg: Registration = {
        active: new Set(),
        allowlist: [...allowlist],
        release() {
          released ??= (async () => {
            reg.released = true;
            registrations.delete(key);
            const active = [...reg.active];
            for (const call of active) {
              call.stop();
            }
            let timer: NodeJS.Timeout | undefined;
            try {
              await Promise.race([
                Promise.allSettled(active.map((call) => call.done)),
                new Promise<void>((resolve) => {
                  timer = setTimeout(resolve, bound);
                  timer.unref();
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          })();
          return released;
        },
        released: false,
        run: AsyncResource.bind(<T>(body: () => T): T => body()),
        write: AsyncResource.bind(async (row) => {
          try {
            await prisma.workflowHttpCall.createMany({
              data: [{ ...base, ...row } as CallRow],
              skipDuplicates: true,
            });
          } catch {
            failures.add(1);
            logWarn('egress proxy HTTP capture persistence failed');
          }
        }),
      };
      registrations.set(key, reg);
      return {
        release: reg.release,
        token,
        url:
          typeof options.advertisedUrl === 'function'
            ? options.advertisedUrl(port)
            : options.advertisedUrl,
      };
    },
  };
}

let shared: ReturnType<typeof createEgressProxy> | null | undefined;
export function workerEgressProxy() {
  if (shared === undefined) {
    const config = resolveWorkspaceInfra().egressProxy;
    shared = config
      ? createEgressProxy({
          advertisedUrl: config.url,
          listenHost: config.bindHost,
          listenPort: config.port,
        })
      : null;
  }
  return shared;
}
