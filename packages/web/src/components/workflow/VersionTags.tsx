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
        <Badge tone="ember" variant="outline">
          Default
        </Badge>
      )}
      {active && (
        <Badge tone="moss" variant="outline">
          Active
        </Badge>
      )}
      {experiment && (
        <Badge tone="violet" variant="outline">
          Experiment
        </Badge>
      )}
      {needsReview && (
        <Badge tone="amber" variant="outline">
          Needs review
        </Badge>
      )}
    </>
  );
}
