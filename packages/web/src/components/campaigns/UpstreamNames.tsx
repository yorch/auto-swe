import { targetAnchor } from './campaignDisplay';

/**
 * The repositories a target waits for, by name, each linking to its row when the page has one. An
 * id with no label is a repository the viewer cannot see, and is said so rather than named.
 */
export function UpstreamNames({
  labels,
  linkable = false,
  targetIds,
}: {
  labels: ReadonlyMap<string, string>;
  /** Link each name to the row with that id (the row must be on the page). */
  linkable?: boolean;
  targetIds: readonly string[];
}) {
  return (
    <>
      {targetIds.map((id, i) => {
        const label = labels.get(id);
        return (
          <span key={id}>
            {i > 0 && ', '}
            {label ? (
              linkable ? (
                <a
                  className="text-paper-200 underline-offset-2 hover:underline"
                  href={`#${targetAnchor(id)}`}
                >
                  {label}
                </a>
              ) : (
                <span className="text-paper-200">{label}</span>
              )
            ) : (
              <span className="text-paper-500">a repository you cannot see</span>
            )}
          </span>
        );
      })}
    </>
  );
}
