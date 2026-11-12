import { prisma } from '@auto-swe/shared/db';
import { SetupBlockerSchema } from '@auto-swe/shared/lib/setupBlocker';
import { currentWorkflowId } from './activityContext.js';
import { logWarn } from './activityLog.js';

export async function recordSetupFailure(connectionId: string, error: unknown): Promise<void> {
  try {
    if (!error || typeof error !== 'object' || !('details' in error)) {
      return;
    }
    const details = error.details;
    if (!Array.isArray(details)) {
      return;
    }
    const parsed = SetupBlockerSchema.safeParse(details[0]);
    if (!parsed.success) {
      return;
    }
    const blocker = parsed.data;
    const now = new Date();
    const lastWorkflowId = currentWorkflowId();
    await prisma.repoSetupBlocker.upsert({
      create: {
        connectionId,
        ...blocker,
        firstSeenAt: now,
        lastSeenAt: now,
        lastWorkflowId,
        occurrences: 1,
      },
      update: {
        ...blocker,
        lastSeenAt: now,
        lastWorkflowId,
        occurrences: { increment: 1 },
        resolvedAt: null,
        step: blocker.step ?? null,
      },
      where: {
        connectionId_kind_subject: { connectionId, kind: blocker.kind, subject: blocker.subject },
      },
    });
  } catch (error) {
    logWarn('workspace setup: could not record blocker', {
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function resolveSetupBlockers(connectionId: string): Promise<void> {
  try {
    await prisma.repoSetupBlocker.updateMany({
      data: { resolvedAt: new Date() },
      where: { connectionId, resolvedAt: null },
    });
  } catch (error) {
    logWarn('workspace setup: could not resolve blockers', {
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
