import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { sendError } from './httpErrors.js';

function fakeReply() {
  const reply = { send: vi.fn(), status: vi.fn() };
  reply.status.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply;
}

describe('sendError', () => {
  it('sends the code and message with the status', () => {
    const reply = fakeReply();
    sendError(reply as unknown as FastifyReply, 404, 'NOT_FOUND', 'Gone');
    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({ error: { code: 'NOT_FOUND', message: 'Gone' } });
  });

  it('nests extras under details, where they cannot shadow code or message', () => {
    const reply = fakeReply();
    sendError(reply as unknown as FastifyReply, 422, 'VALIDATION_ERROR', 'Invalid', {
      code: 'shadow',
      issues: [{ path: ['issue'] }],
    });
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_ERROR',
        details: { code: 'shadow', issues: [{ path: ['issue'] }] },
        message: 'Invalid',
      },
    });
  });
});
