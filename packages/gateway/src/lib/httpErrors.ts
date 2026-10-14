import type { FastifyReply } from 'fastify';

/**
 * Send the gateway's error envelope, `{ error: { code, message, details? } }`.
 *
 * Every route answers failures in this one shape, which the web client and the
 * CLI read without branching on the route. `details` carries structured extras
 * (validation issues, the refused repositories) when a caller has them, always
 * nested under `error.details` so they can never shadow `code` or `message`.
 */
export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: unknown
): FastifyReply {
  const error = details === undefined ? { code, message } : { code, details, message };
  return reply.status(status).send({ error });
}
