import { AsyncLocalStorage } from 'node:async_hooks';
import { isIPv4, isIPv6 } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthMethod } from '../plugins/auth.js';

/**
 * How an audited action arrived. Stored on `ConfigAuditLog.context`; every field is optional
 * because which of them exist depends on the credential path.
 */
export interface AuditContext {
  via?: AuthMethod;
  requestId?: string;
  /** Truncated: /24 for IPv4, /48 for IPv6. Omitted for assistant calls. */
  ip?: string;
  servicePrincipalId?: string;
  conversationId?: string;
  actionId?: string;
  mcpClientId?: string;
}

/** The store holds the request itself so the context is read after authentication has run. */
const storage = new AsyncLocalStorage<{ request: FastifyRequest }>();

/**
 * Truncate an address so the log never holds a full client IP: the first three octets of an IPv4
 * address (the rest zeroed) or the first three groups of an IPv6 address. An IPv4-mapped IPv6
 * address is treated as the IPv4 address it wraps. Anything unparseable yields `undefined`.
 */
export function truncateIp(raw: string | null | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  let ip = raw.trim();
  const zone = ip.indexOf('%');
  if (zone >= 0) {
    ip = ip.slice(0, zone);
  }
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) {
    ip = mapped[1];
  }
  if (isIPv4(ip)) {
    const [a, b, c] = ip.split('.');
    return `${a}.${b}.${c}.0`;
  }
  if (isIPv6(ip)) {
    const groups = expandIpv6(ip);
    return groups ? `${groups.slice(0, 3).join(':')}::` : undefined;
  }
  return undefined;
}

/** The eight 16-bit groups of a valid IPv6 address, as hex without leading zeros. */
function expandIpv6(ip: string): string[] | undefined {
  let text = ip;
  const tail = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail?.[1] && tail[2]) {
    const [a = 0, b = 0, c = 0, d = 0] = tail[2].split('.').map(Number);
    text = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const fill = text.includes('::')
    ? new Array<string>(8 - left.length - right.length).fill('0')
    : [];
  const groups = [...left, ...fill, ...right];
  if (groups.length !== 8) {
    return undefined;
  }
  return groups.map((g) => Number.parseInt(g, 16).toString(16));
}

/** The context of a request, built from the request object itself (usable from `onResponse`). */
export function auditContextOf(request: FastifyRequest): AuditContext {
  const via = request.authMethod;
  const context: AuditContext = { requestId: request.id };
  if (via) {
    context.via = via;
  }
  // The assistant calls from the worker, so the peer address is ours, not the user's. An MCP
  // bridged call is injected with the outer request's client address as its remote address, so
  // `request.ip` is the real client there and is kept.
  if (via !== 'assistant') {
    const ip = truncateIp(request.ip);
    if (ip) {
      context.ip = ip;
    }
  }
  if (request.principal) {
    context.servicePrincipalId = request.principal.servicePrincipalId;
  }
  if (request.assistant) {
    context.conversationId = request.assistant.conversationId;
    if (request.assistant.actionId) {
      context.actionId = request.assistant.actionId;
    }
  }
  if (request.mcpBridge) {
    context.mcpClientId = request.mcpBridge.clientId;
  }
  return context;
}

/** The context of the request being handled, or `undefined` outside one. */
export function currentAuditContext(): AuditContext | undefined {
  const store = storage.getStore();
  return store ? auditContextOf(store.request) : undefined;
}

/** `{ context }` to spread into a `configAuditLog.create` `data`, or `{}` outside a request. */
export function auditContextData(context?: AuditContext): { context?: never } {
  const resolved = context ?? currentAuditContext();
  return resolved ? { context: resolved as never } : {};
}

/**
 * Run the handler inside the request's audit context. The store holds the request itself and the
 * context is built when a row is written, because some routes authenticate in their own
 * `preHandler`: a snapshot taken here would run before auth and leave `via` empty.
 */
export function registerAuditContext(app: FastifyInstance): void {
  app.addHook('preHandler', (request, _reply, done) => {
    storage.run({ request }, done);
  });
}
