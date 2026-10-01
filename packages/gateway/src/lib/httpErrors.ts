import type { FastifyReply } from 'fastify';

/**
 * Send the gateway's error envelope, `{ error: { code, message } }`.
 *
 * Every route answers failures in this one shape, which the web client and the
 * CLI read without branching on the route. `details` carries structured extras
 * (validation issues, the refused repositories) when a caller has them.
 */
export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): FastifyReply {
  return reply.status(status).send({ error: { code, message, ...(details ?? {}) } });
}
