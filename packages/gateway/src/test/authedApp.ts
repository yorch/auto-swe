import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

/** Default `sub` claim for the fake JWT. Override per test when it must match a row. */
const DEFAULT_SUB = '00000000-0000-4000-8000-0000000000aa';

/**
 * Build a Fastify app wired with the standard test doubles used by gateway
 * route tests: the zod compilers, the provided prisma mock, a fake
 * `verifyAccessToken` returning the given platform role, and (by default) an
 * onRequest hook that injects a Bearer token so every request authenticates.
 *
 * The caller registers its routes on the returned app and supplies the
 * route-specific prisma mock — only the auth/compiler boilerplate is shared.
 */
export function makeAuthedApp({
  prisma,
  role,
  sub = DEFAULT_SUB,
  injectBearer = true,
}: {
  prisma: unknown;
  role: string;
  sub?: string;
  injectBearer?: boolean;
}): FastifyInstance {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('prisma', prisma as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9_999_999_999, iat: 0, role, sub }),
  } as unknown as never);

  if (injectBearer) {
    app.addHook('onRequest', async (req) => {
      req.headers.authorization = 'Bearer fake-token';
    });
  }
  return app;
}
