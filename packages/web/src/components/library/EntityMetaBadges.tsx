import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';

/**
 * The badge row at the top of a library entity's detail view — built-in,
 * bundle origin, verification, active state — shared by scanner patterns and
 * skills. `isVerified` is optional: entities without a verification concept
 * omit it. `children` append entity-specific badges after the shared ones.
 */
export function EntityMetaBadges({
  children,
  isActive,
  isBuiltIn,
  isVerified,
  origin,
}: {
  children?: ReactNode;
  isActive: boolean;
  isBuiltIn: boolean;
  isVerified?: boolean;
  origin: string | null;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {isBuiltIn && (
        <Badge tone="neutral" uppercase>
          built-in
        </Badge>
      )}
      {origin && <Badge tone="neutral">origin: {origin}</Badge>}
      {isVerified === true && <Badge tone="moss">verified</Badge>}
      {isVerified === false && !isBuiltIn && <Badge tone="amber">unverified</Badge>}
      <Badge tone={isActive ? 'ember' : 'muted'}>{isActive ? 'active' : 'inactive'}</Badge>
      {children}
    </div>
  );
}
