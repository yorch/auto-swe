import { resolveSetting } from '../config/resolveSetting.js';
import { prisma } from '../db.js';
import { deleteArtifact, putArtifact } from './artifactStore.js';

export type RunEvidenceKind = 'screenshot' | 'video' | 'trace' | 'log';
export type RunEvidenceSource = 'uiVerify' | 'agent';

export interface RecordRunEvidenceInput {
  runId: string;
  kind: RunEvidenceKind;
  source: RunEvidenceSource;
  body: Buffer | string;
  contentType: string;
  caption?: string;
  pageUrl?: string;
  specNodeId?: string;
  stepAttempt?: number;
  width?: number;
  height?: number;
}

export type RecordRunEvidenceResult =
  | { ok: true; evidenceId: string; artifactId: string }
  | { ok: false; reason: 'too_large' | 'run_cap' };

/** The artifact kinds UI evidence writes. The daily sweep reaps ones no row links. */
export const UI_EVIDENCE_ARTIFACT_KINDS = [
  'ui.log',
  'ui.screenshot',
  'ui.trace',
  'ui.video',
] as const;

export function uiEvidenceArtifactKind(kind: RunEvidenceKind): string {
  return `ui.${kind}`;
}

const CONTENT_TYPES: Record<RunEvidenceKind, string> = {
  log: 'text/plain; charset=utf-8',
  screenshot: 'image/png',
  trace: 'application/zip',
  video: 'video/webm',
};

export async function recordRunEvidence(
  input: RecordRunEvidenceInput
): Promise<RecordRunEvidenceResult> {
  const [maxScreenshotBytes, maxVideoBytes, maxEvidencePerRun] = await Promise.all([
    resolveSetting('uiValidation.maxScreenshotBytes'),
    resolveSetting('uiValidation.maxVideoBytes'),
    resolveSetting('uiValidation.maxEvidencePerRun'),
  ]);
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body, 'utf8');
  const maxBytes =
    input.kind === 'screenshot'
      ? maxScreenshotBytes
      : input.kind === 'video'
        ? maxVideoBytes
        : Number.POSITIVE_INFINITY;
  if (body.byteLength > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }
  if (input.contentType !== CONTENT_TYPES[input.kind]) {
    throw new Error(`invalid content type for ${input.kind} evidence`);
  }

  const artifact = await putArtifact({
    body,
    contentType: input.contentType,
    kind: uiEvidenceArtifactKind(input.kind),
    runId: input.runId,
  });
  try {
    const evidence = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.runId}, 0))`;
      if ((await tx.runEvidence.count({ where: { runId: input.runId } })) >= maxEvidencePerRun) {
        return null;
      }
      return tx.runEvidence.create({
        data: {
          artifactId: artifact.id,
          caption: input.caption?.slice(0, 500),
          height: input.height,
          kind: input.kind,
          pageUrl: input.pageUrl?.slice(0, 2000),
          runId: input.runId,
          source: input.source,
          specNodeId: input.specNodeId,
          stepAttempt: input.stepAttempt,
          width: input.width,
        },
        select: { id: true },
      });
    });
    if (!evidence) {
      await deleteArtifact(artifact.id);
      return { ok: false, reason: 'run_cap' };
    }
    return { artifactId: artifact.id, evidenceId: evidence.id, ok: true };
  } catch (error) {
    await deleteArtifact(artifact.id).catch(() => undefined);
    throw error;
  }
}
