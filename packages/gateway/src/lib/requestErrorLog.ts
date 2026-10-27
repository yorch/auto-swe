import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ipRateLimitKey, rateLimitKey } from '../plugins/auth.js';
import { isTemporalUnavailable } from './temporalErrors.js';

/**
 * Log an error the app error handler is about to answer.
 *
 * A rate-limit refusal is the limiter working, not a fault: one WARN line, no
 * error object, because the stack points at the plugin and a burst of 429s
 * would otherwise flood the error log. Everything else is unchanged.
 */
export function logRequestError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: FastifyError
): void {
  if (error.statusCode === 429) {
    let key: string;
    try {
      key = rateLimitKey(request);
    } catch {
      key = ipRateLimitKey(request);
    }
    request.log.warn(
      `rate limit exceeded: route=${request.routeOptions.url ?? request.url.split('?')[0]} key=${key.split(':')[0]} limit=${reply.getHeader('x-ratelimit-limit')}`
    );
    return;
  }
  // Temporal not being connected yet is expected and retryable; pollers would flood
  // the error level during the connect window.
  if (isTemporalUnavailable(error)) {
    request.log.warn({ err: error }, 'Temporal not connected');
  } else {
    request.log.error(error);
  }
}
