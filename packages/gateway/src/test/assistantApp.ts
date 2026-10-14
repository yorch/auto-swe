import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { vi } from 'vitest';
import authPlugin from '../plugins/auth.js';

/**
 * An app with the real auth plugin, so assistant tokens are minted and verified for real, over a
 * mocked database. The caller mocks `@auto-swe/shared/config` (for `assistant.enabled`) and
 * `@auto-swe/shared/lib/repoAccessGate` in its own file, since `vi.mock` is hoisted per file.
 */

export const USER_ID = '00000000-0000-4000-8000-0000000000aa';
export const OTHER_USER_ID = '00000000-0000-4000-8000-0000000000bb';
export const CONVERSATION_ID = '00000000-0000-4000-8000-0000000000c1';
export const ACTION_ID = '00000000-0000-4000-8000-0000000000d1';

export function makeAssistantPrisma() {
  return {
    assistantAction: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    /** The token's conversation is open and the user's unless a test says otherwise. */
    assistantConversation: {
      findFirst: vi.fn().mockResolvedValue({ id: CONVERSATION_ID }),
    },
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    user: {
      findUnique: vi.fn().mockResolvedValue({ isActive: true, role: 'ENGINEER', slackId: null }),
    },
  };
}
export type AssistantPrisma = ReturnType<typeof makeAssistantPrisma>;

export async function buildAssistantApp(
  prisma: AssistantPrisma,
  register: (app: FastifyInstance) => Promise<void> | void
): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', prisma as never);
  await app.register(authPlugin);
  await register(app);
  await app.ready();
  return app;
}

/** An assistant token for `USER_ID` in `CONVERSATION_ID`, unless told otherwise. */
export function assistantBearer(
  app: FastifyInstance,
  claims: { userId?: string; conversationId?: string } = {}
): string {
  return `Bearer ${app.auth.signAssistantToken({
    conversationId: claims.conversationId ?? CONVERSATION_ID,
    userId: claims.userId ?? USER_ID,
  })}`;
}

/** An ordinary API access token for `USER_ID`: the person, not their assistant. */
export function personBearer(app: FastifyInstance): string {
  return `Bearer ${app.auth.signAccessToken({ role: 'ENGINEER', sub: USER_ID })}`;
}
