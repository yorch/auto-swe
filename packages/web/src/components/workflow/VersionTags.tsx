import { Badge } from '@/components/ui/Badge';

/**
 * The tag cluster a template or template version carries: default template,
 * active version, A/B experiment arm, AI-generated version awaiting review.
 * Renders only the badges that apply, as siblings — the caller owns layout.
 */
export function VersionTags({
  active = false,
  experiment = false,
  isDefault = false,
  needsReview = false,
}: {
  active?: boolean;
  experiment?: boolean;
  isDefault?: boolean;
  needsReview?: boolean;
}) {
  return (
    <>
      {isDefault && (
        <Badge tone="ember" uppercase variant="outline">
          default
        </Badge>
      )}
      {active && (
        <Badge tone="moss" uppercase variant="outline">
          active
        </Badge>
      )}
      {experiment && (
        <Badge tone="violet" uppercase variant="outline">
          experiment
        </Badge>
      )}
      {needsReview && (
        <Badge tone="ember" uppercase variant="outline">
          needs review
        </Badge>
      )}
    </>
  );
}
