import { keyed } from '@/components/harnessProfiles/profileDisplay';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import type { CatalogEntryDto } from '@/hooks/useMarketplaces';
import { visibleText } from '@/lib/visibleText';
import { entrySourceLabel, entryStatus } from './marketplaceDisplay';

/**
 * A marketplace's catalog as text: every name, description and path came from the repository and
 * is shown through `visibleText`. With `onApprove`, an installable entry whose name is free (or
 * that already has a plugin from this marketplace) gets an Approve button.
 */
export function CatalogTable({
  entries,
  onApprove,
}: {
  entries: CatalogEntryDto[];
  onApprove?: (entry: CatalogEntryDto) => void;
}) {
  if (entries.length === 0) {
    return <p className="text-xs text-paper-500">This marketplace lists no plugins.</p>;
  }
  const keys = keyed(entries.map((e) => `${e.name ?? ''}|${entrySourceLabel(e.source)}`));
  return (
    <Table>
      <THead>
        <Th variant="compact">Plugin</Th>
        <Th variant="compact">Source</Th>
        <Th variant="compact">Status</Th>
        {onApprove && <Th variant="compact" />}
      </THead>
      <tbody>
        {entries.map((e, i) => {
          const rowKey = keys[i]?.key ?? String(i);
          const status = entryStatus(e);
          const label = e.name === null ? '(no valid name)' : visibleText(e.name);
          return (
            <TRow key={rowKey}>
              <Td className="py-2 pr-4 align-top">
                <div className="font-medium text-paper-100">{label}</div>
                {e.version && (
                  <div className="text-xs text-paper-500">v{visibleText(e.version)}</div>
                )}
                {e.description && (
                  <div className="mt-0.5 text-xs text-paper-400">{visibleText(e.description)}</div>
                )}
              </Td>
              <Td className="py-2 pr-4 align-top font-mono text-xs text-paper-300 break-all">
                {entrySourceLabel(e.source)}
              </Td>
              <Td className="py-2 pr-4 align-top">
                <div className="flex flex-wrap items-center gap-1">
                  <Badge dot tone={status.tone}>
                    {status.label}
                  </Badge>
                  {e.profile && (
                    <Badge tone="accent2" variant="outline">
                      Approved as {visibleText(e.profile.name)} v{e.profile.latestVersion}
                      {e.profile.status === 'OK' ? '' : ' (disabled)'}
                    </Badge>
                  )}
                  {e.nameTaken && (
                    <Badge tone="warning" variant="outline">
                      Name taken
                    </Badge>
                  )}
                </div>
                {!e.installable && e.reason && (
                  <div className="mt-1 text-xs text-paper-500">{visibleText(e.reason)}</div>
                )}
                {e.nameTaken && (
                  <div className="mt-1 text-xs text-paper-500">
                    A plugin with this name exists that did not come from this entry, so it cannot
                    be approved.
                  </div>
                )}
              </Td>
              {onApprove && (
                <Td className="py-2 align-top">
                  {e.installable && !e.nameTaken && !e.profile && (
                    <Button
                      aria-label={`Approve ${label}`}
                      onClick={() => onApprove(e)}
                      size="sm"
                      variant="primary"
                    >
                      Approve
                    </Button>
                  )}
                </Td>
              )}
            </TRow>
          );
        })}
      </tbody>
    </Table>
  );
}
