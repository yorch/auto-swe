import { resolveSetting } from '@auto-swe/shared/config/resolveSetting';
import { prisma } from '@auto-swe/shared/db';
import { getArtifact, putObjectToBucket } from '@auto-swe/shared/lib/artifactStore';
import { resolveWebUrl } from '@auto-swe/shared/lib/systemConfig';
import { logWarn } from './activityLog.js';

type EvidenceRow = {
  id: string;
  artifactId: string;
  caption: string | null;
  kind: string;
};

function markdownText(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}

export async function buildPrUiEvidence(runId?: string | null): Promise<string> {
  if (!runId) {
    return '';
  }
  const rows = (await prisma.runEvidence.findMany({
    orderBy: { createdAt: 'asc' },
    select: { artifactId: true, caption: true, id: true, kind: true },
    where: { runId },
  })) as EvidenceRow[];
  if (rows.length === 0) {
    return '';
  }

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  }
  const summary = ['screenshot', 'video', 'trace', 'log']
    .filter((kind) => counts.has(kind))
    .map((kind) => `${counts.get(kind)} ${kind}${counts.get(kind) === 1 ? '' : 's'}`)
    .join(', ');
  const dashboardUrl = `${resolveWebUrl().replace(/\/$/, '')}/runs/${encodeURIComponent(runId)}#evidence`;
  const lines = [
    '### UI evidence',
    '',
    `Evidence: ${summary}`,
    '',
    `[View run evidence](${dashboardUrl})`,
  ];

  const inlineImages = await resolveSetting('uiValidation.prInlineImages');
  const bucket = process.env.UI_EVIDENCE_PUBLIC_BUCKET?.trim();
  const baseUrl = process.env.UI_EVIDENCE_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (inlineImages === true && bucket && baseUrl) {
    const publicBase = new URL(baseUrl);
    if (publicBase.protocol !== 'https:' && publicBase.protocol !== 'http:') {
      throw new Error('UI_EVIDENCE_PUBLIC_BASE_URL must use http or https');
    }
    const screenshots = rows.filter((row) => row.kind === 'screenshot').slice(0, 6);
    for (const screenshot of screenshots) {
      try {
        const { body } = await getArtifact(screenshot.artifactId);
        const key = `ui-evidence/${runId}/${screenshot.id}.png`;
        await putObjectToBucket(bucket, key, body, 'image/png');
        const url = `${baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
        lines.push('', `![${markdownText(screenshot.caption ?? 'UI screenshot')}](${url})`);
      } catch (error) {
        logWarn('Could not copy UI screenshot to the configured public bucket', {
          error: error instanceof Error ? error.message : String(error),
          evidenceId: screenshot.id,
        });
      }
    }
  }
  return lines.join('\n');
}
