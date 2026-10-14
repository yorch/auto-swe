import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { RailCard } from './RailCard';

interface LaunchInputsCardProps {
  inputSchema: InputSchema | null;
  canManage: boolean;
  onEdit: () => void;
}

/** The fields people fill in when they run the workflow. */
export function LaunchInputsCard({ inputSchema, canManage, onEdit }: LaunchInputsCardProps) {
  return (
    <RailCard
      action={
        canManage ? (
          <Button aria-label="Edit launch inputs" onClick={onEdit} size="sm" variant="ghost">
            Edit
          </Button>
        ) : undefined
      }
      title="Launch inputs"
    >
      {inputSchema ? (
        <ul className="divide-y divide-ink-600">
          {Object.entries(inputSchema.properties).map(([key, prop]) => (
            <li
              className="flex items-baseline justify-between gap-2 py-1.5 first:pt-0 last:pb-0"
              key={key}
            >
              <span className="min-w-0 truncate font-mono text-xs text-paper-200">{key}</span>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-paper-500">
                {prop.type}
                {inputSchema.required?.includes(key) && (
                  <Badge tone="amber" variant="outline">
                    Required
                  </Badge>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs leading-relaxed text-paper-500">
          No launch inputs, so a run accepts any input.
        </p>
      )}
    </RailCard>
  );
}
