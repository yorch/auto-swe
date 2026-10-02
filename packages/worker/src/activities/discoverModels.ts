/**
 * The scheduled provider model-discovery run: asks each GLOBAL provider
 * credential which models it lists and records the result as suggestions
 * (`model_suggestions`), never as catalog rows. The listing, parsing, SSRF guard
 * and persistence rules are the shared ones the gateway's on-demand route runs.
 *
 * A provider that cannot be listed is logged and recorded on its own status row;
 * it never fails the run and never changes that provider's suggestions.
 */
import { prisma } from '@auto-swe/shared/db';
import { runModelDiscovery } from '@auto-swe/shared/lib/modelSuggestions';
import { log } from '@temporalio/activity';

export interface DiscoverModelsResult {
  providers: Array<{
    provider: string;
    ok: boolean;
    error?: string;
    newModels: number;
    retirementCandidates: number;
  }>;
}

export async function discoverModels(): Promise<DiscoverModelsResult> {
  const { summary } = await runModelDiscovery(prisma);
  for (const p of summary.providers) {
    if (!p.ok) {
      // This runs from a Schedule with no `WorkflowRun` row, so a trace would
      // reach nobody; the log line and the stored status row are the record.
      log.warn('model discovery: provider listing failed; its suggestions are unchanged', {
        error: p.error,
        provider: p.provider,
      });
    }
  }
  log.info('model discovery complete', { providers: summary.providers });
  return summary;
}
