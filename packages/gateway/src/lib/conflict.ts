import type { FastifyReply } from 'fastify';

export type ConflictCode = 'REPO_EXISTS' | 'TEAM_EXISTS' | 'MEMBER_EXISTS';

export function sendConflict(reply: FastifyReply, code: ConflictCode, message: string) {
  return reply.status(409).send({
    error: { code, message },
  });
}
