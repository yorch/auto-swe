import { Card } from '@/components/ui/Card';

/** One card of the right rail: a small heading, an optional hint and action, then the body. */
export function RailCard({
  action,
  children,
  help,
  hint,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  /** A HelpTip beside the title. */
  help?: React.ReactNode;
  hint?: string;
  title: string;
}) {
  return (
    <Card className="p-4" variant="inset">
      <div className="mb-3 flex min-h-7 items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-paper-100">
          {title}
          {hint && <span className="ml-2 font-normal text-paper-500">{hint}</span>}
          {help && <span className="ml-1">{help}</span>}
        </h2>
        {action}
      </div>
      {children}
    </Card>
  );
}
