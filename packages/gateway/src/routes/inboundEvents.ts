/**
 * The event-endpoint receiver (docs/inbound-events.md): `POST /api/v1/webhooks/events/:endpointId`.
 * No session or token: a call proves itself with the endpoint's signature scheme, checked over
 * the raw body bytes before anything else is read. The body is parsed only after that, and only
 * the values the team's automations ask for ever reach the ledger.
 *
 * Its own plugin, so the body arrives as bytes: every content type is read as a Buffer and
 * nothing is parsed before the signature is checked.
 */

import { extractInboundEvent, MAX_EVENT_BODY_BYTES } from '@auto-swe/shared/automation';
import { resolveSetting } from '@auto-swe/shared/config';
import type { FastifyPluginAsync } from 'fastify';
import { AutomationStartError, engineTeamSelect } from '../lib/automations/engine.js';
import { handleInboundEvent } from '../lib/automations/inboundEvent.js';
import {
  DELIVERY_LOOP_HEADER,
  readEventDocument,
  sha256Hex,
  verifyEndpointCall,
} from '../lib/eventEndpoints.js';
import { sendError } from '../lib/httpErrors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const inboundEventRoutes: FastifyPluginAsync = async (fastify) => {
  // Bytes, whatever the content type: the signature covers the body as sent.
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser(
    '*',
    { bodyLimit: MAX_EVENT_BODY_BYTES, parseAs: 'buffer' },
    (_request, body, done) => done(null, body)
  );

  fastify.post<{ Params: { endpointId: string } }>(
    '/:endpointId',
    {
      bodyLimit: MAX_EVENT_BODY_BYTES,
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      // A call the platform itself sent (a completion callback pointed back here) is never an
      // event: answering it with a run would loop. Accepted and dropped, nothing recorded.
      if (request.headers[DELIVERY_LOOP_HEADER] !== undefined) {
        return reply.status(202).send({ data: { ignored: true } });
      }
      const { endpointId } = request.params;
      const endpoint = UUID_RE.test(endpointId)
        ? await fastify.prisma.eventEndpoint.findUnique({
            include: { team: { select: { ...engineTeamSelect, isActive: true } } },
            where: { id: endpointId },
          })
        : null;
      if (!endpoint) {
        return sendError(reply, 404, 'EVENT_ENDPOINT_NOT_FOUND', 'Event endpoint not found');
      }
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const now = new Date();
      // The signature first: a caller that cannot sign learns nothing else about the endpoint.
      let verified: ReturnType<typeof verifyEndpointCall>;
      try {
        verified = verifyEndpointCall({ endpoint, headers: request.headers, now, rawBody });
      } catch (err) {
        // A secret that cannot be decrypted (a missing key version): the deployment's fault.
        request.log.error({ endpointId, err }, 'event endpoint secret could not be read');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'The event could not be verified');
      }
      if (!verified.ok) {
        // The reason stays in the gateway's log; the caller is told only that it was refused.
        request.log.info({ endpointId, reason: verified.reason }, 'event endpoint call refused');
        return sendError(
          reply,
          401,
          'SIGNATURE_INVALID',
          'The call is not signed for this endpoint'
        );
      }
      if (!endpoint.enabled) {
        return sendError(reply, 409, 'EVENT_ENDPOINT_DISABLED', 'The event endpoint is disabled');
      }
      if (!endpoint.team.isActive) {
        return sendError(reply, 409, 'TEAM_INACTIVE', 'The team is not active');
      }
      const switchedOn = await resolveSetting('workflow.inboundEventsEnabled', {
        ...(endpoint.team.orgId ? { orgId: endpoint.team.orgId } : {}),
        teamId: endpoint.teamId,
      });
      if (switchedOn !== true) {
        return sendError(
          reply,
          409,
          'INBOUND_EVENTS_DISABLED',
          'Inbound events are switched off for this team'
        );
      }
      const document = readEventDocument({
        format: endpoint.format,
        headers: request.headers,
        rawBody,
      });
      if (!document.ok) {
        return sendError(
          reply,
          document.code === 'UNSUPPORTED_EVENT' ? 415 : 400,
          document.code,
          document.message
        );
      }
      const extracted = extractInboundEvent({
        bodyDigest: sha256Hex(rawBody),
        document: document.document,
        endpointId: endpoint.id,
        hash: sha256Hex,
        pointers: endpoint,
      });
      if (!extracted.ok) {
        return sendError(reply, 422, extracted.code, extracted.message);
      }
      const { event } = extracted;
      let result: Awaited<ReturnType<typeof handleInboundEvent>>;
      try {
        result = await handleInboundEvent(
          fastify,
          { id: endpoint.id, team: endpoint.team, teamId: endpoint.teamId },
          event,
          now
        );
      } catch (err) {
        if (err instanceof AutomationStartError) {
          request.log.error({ endpointId, err }, 'an inbound event run could not be started');
          return sendError(
            reply,
            503,
            'AUTOMATION_START_FAILED',
            'The run could not be started; send the event again'
          );
        }
        throw err;
      }
      // What became of it, without why: the reasons name the team's automations and limits.
      const data =
        'ignored' in result
          ? { eventId: event.id, ignored: true }
          : 'duplicate' in result
            ? { duplicate: true, eventId: event.id }
            : { eventId: event.id, outcome: result.outcome };
      return reply.status(202).send({ data });
    }
  );
};
