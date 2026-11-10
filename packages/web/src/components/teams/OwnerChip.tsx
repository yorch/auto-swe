import { Badge } from '@/components/ui/Badge';

/**
 * Names the team that owns a repository (or an item on one) when the viewer is looking at it
 * through another team. Renders nothing for the owning team's own view.
 */
export function OwnerChip({
  ownerName,
  className,
}: {
  ownerName: string | null | undefined;
  className?: string;
}) {
  if (!ownerName) {
    return null;
  }
  return (
    <Badge className={className} tone="info" variant="outline">
      <span data-testid="owner-chip">owned by {ownerName}</span>
    </Badge>
  );
}
