import { prisma } from '@auto-swe/shared/db';
import { resolveBetterAuthConfig } from '@auto-swe/shared/lib/systemConfig';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditContextData, auditContextOf } from './auditContext.js';
import { getAuth, MCP_RESOURCE } from './betterAuth.js';
import { MCP_GRANT_ENTITY } from './mcpGrants.js';
import { MCP_SCOPE_WRITE, MCP_SCOPES } from './mcpOAuth.js';

const decision = z.object({ userCode: z.string().min(1).max(191) }).strict();

export async function approveMcpDevice(request: FastifyRequest, reply: FastifyReply) {
  const refuse = (status: number, error: string, description: string) =>
    reply
      .status(status)
      .header('cache-control', 'no-store')
      .send({ error, error_description: description });
  if (request.method !== 'POST') {
    return refuse(405, 'invalid_request', 'POST required');
  }
  if (request.headers.origin !== resolveBetterAuthConfig().clientOrigin) {
    return refuse(403, 'access_denied', 'A trusted Origin is required');
  }
  const parsed = decision.safeParse(request.body);
  if (!parsed.success) {
    return refuse(400, 'invalid_request', 'A userCode is required');
  }
  const session = await getAuth().api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) {
    return refuse(401, 'unauthorized', 'Sign in to approve this request');
  }
  const result = await prisma.$transaction(async (tx) => {
    const users = await tx.$queryRaw<
      Array<{ is_active: boolean }>
    >`SELECT is_active FROM users WHERE id = ${session.user.id}::uuid FOR UPDATE`;
    if (users[0]?.is_active !== true) {
      return { description: 'This account is not active', error: 'access_denied', status: 403 };
    }
    const enabled = async (key: string) =>
      (await tx.configSetting.findFirst({ where: { key, scope: 'GLOBAL' } }))?.value === true;
    if (!(await enabled('mcp.enabled')) || !(await enabled('mcp.deviceFlowEnabled'))) {
      return { description: '', error: 'absent', status: 404 };
    }
    const userCode = parsed.data.userCode;
    const normalized = userCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const code =
      (await tx.deviceCode.findUnique({ where: { userCode } })) ??
      (/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/.test(normalized)
        ? await tx.deviceCode.findUnique({ where: { userCode: normalized } })
        : null);
    if (
      !code ||
      code.userId !== session.user.id ||
      !code.oauthClientId ||
      code.status !== 'pending'
    ) {
      return {
        description: 'Invalid or already processed user code',
        error: 'invalid_request',
        status: 400,
      };
    }
    if (code.expiresAt <= new Date()) {
      return { description: 'This user code has expired', error: 'expired_token', status: 400 };
    }
    if (code.resources?.length !== 1 || code.resources[0] !== MCP_RESOURCE) {
      return { description: 'The MCP resource is required', error: 'invalid_target', status: 400 };
    }
    const scopes = code.scope?.split(/\s+/).filter(Boolean) ?? [];
    if (
      !scopes.length ||
      scopes.some((s) => !(MCP_SCOPES as readonly string[]).includes(s)) ||
      (scopes.includes(MCP_SCOPE_WRITE) && !(await enabled('mcp.writeToolsEnabled')))
    ) {
      return {
        description: 'The requested access is not enabled',
        error: 'invalid_scope',
        status: 400,
      };
    }
    const client = await tx.oauthClient.findUnique({ where: { clientId: code.oauthClientId } });
    if (!client || client.disabled) {
      return { description: 'This client is not available', error: 'invalid_client', status: 400 };
    }
    const updated = await tx.deviceCode.updateMany({
      data: { status: 'approved' },
      where: {
        expiresAt: { gt: new Date() },
        id: code.id,
        status: 'pending',
        userId: session.user.id,
      },
    });
    if (updated.count !== 1) {
      return {
        description: 'Invalid or already processed user code',
        error: 'invalid_request',
        status: 400,
      };
    }
    const prior = await tx.oauthConsent.findFirst({
      orderBy: { updatedAt: 'desc' },
      where: { clientId: code.oauthClientId, userId: session.user.id },
    });
    const data = {
      requestedUserInfoClaims: [],
      resources: [MCP_RESOURCE],
      scopes,
      updatedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
    };
    const consent = prior
      ? await tx.oauthConsent.update({ data, where: { id: prior.id } })
      : await tx.oauthConsent.create({
          data: { ...data, clientId: code.oauthClientId, userId: session.user.id },
        });
    await tx.configAuditLog.create({
      data: {
        ...auditContextData({ ...auditContextOf(request), via: 'session' }),
        action: 'CREATE',
        actorId: session.user.id,
        afterJson: { clientId: code.oauthClientId, scopes, userId: session.user.id } as never,
        beforeJson: null as never,
        entityId: consent.id,
        entityType: MCP_GRANT_ENTITY,
      },
    });
    return null;
  });
  if (result?.error === 'absent') {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  }
  return result
    ? refuse(result.status, result.error, result.description)
    : reply.header('cache-control', 'no-store').send({ success: true });
}
