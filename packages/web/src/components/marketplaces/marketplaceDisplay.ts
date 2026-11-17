import type { BadgeTone } from '@/components/ui/Badge';
import type { CatalogEntryDto, MarketplaceSourceStatus } from '@/hooks/useMarketplaces';
import { visibleText } from '@/lib/visibleText';

export const STATUS_TONE: Record<MarketplaceSourceStatus, BadgeTone> = {
  DISABLED: 'muted',
  ERROR: 'danger',
  OK: 'success',
  UPDATE_AVAILABLE: 'warning',
};

export const STATUS_LABEL: Record<MarketplaceSourceStatus, string> = {
  DISABLED: 'Disabled',
  ERROR: 'Error',
  OK: 'Up to date',
  UPDATE_AVAILABLE: 'Update available',
};

/** Where a catalog entry's plugin lives, as one line of visible text. */
export function entrySourceLabel(source: CatalogEntryDto['source'] | null): string {
  if (!source) {
    return 'unknown';
  }
  switch (source.kind) {
    case 'relative':
      return visibleText(`in this repository: ${source.path || '/'}`);
    case 'github':
      return visibleText(
        `${source.host}/${source.owner}/${source.repo}${source.path ? `/${source.path}` : ''}@${source.sha ? source.sha.slice(0, 7) : source.ref}`
      );
    default:
      return visibleText(`unsupported (${source.type})`);
  }
}

/** The one-line status of an entry: installable, or the fixed reason it is not. */
export function entryStatus(e: CatalogEntryDto): { label: string; tone: BadgeTone } {
  if (e.installable) {
    return { label: 'Installable', tone: 'success' };
  }
  return { label: 'Not installable', tone: 'muted' };
}
