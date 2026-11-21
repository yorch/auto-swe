import { Badge } from '@/components/ui/Badge';
import { Icon, type IconName } from '@/components/ui/Icon';
import { joinStatusLabel, joinStatusTone } from '@/lib/joinRequests';

const ICONS: Record<string, IconName> = {
  APPROVED: 'checkCircle',
  PENDING_ORG: 'clock',
  PENDING_TEAM: 'clock',
  REJECTED: 'close',
  WITHDRAWN: 'stop',
};

/**
 * A request's status as an icon and words, so it never rests on colour alone. A request the
 * platform closed (`closeReason`) reads as closed automatically, not as a person's decision.
 */
export function JoinRequestStatusChip({
  closeReason,
  status,
}: {
  closeReason?: string | null;
  status: string;
}) {
  return (
    <Badge className="gap-1" tone={joinStatusTone(status)} variant="outline">
      <Icon name={ICONS[status] ?? 'info'} size={12} />
      {joinStatusLabel(status, closeReason)}
    </Badge>
  );
}
