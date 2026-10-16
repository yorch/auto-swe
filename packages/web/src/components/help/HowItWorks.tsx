import type { ReactNode } from 'react';
import { DocLink } from '@/components/ui/DocLink';
import { HelpTip } from '@/components/ui/HelpTip';
import { HELP_LINKS } from '@/lib/helpLinks';
import { cn } from '@/lib/utils';

interface Step {
  title: string;
  body: ReactNode;
}

const STEPS: Step[] = [
  {
    body: (
      <>
        You describe the work as a request <HelpTip term="request" />, from the dashboard, Slack,
        the CLI, or the API.
      </>
    ),
    title: 'Request',
  },
  {
    body: (
      <>
        A run <HelpTip term="run" /> works through the steps of a workflow template, with agents
        coding inside an isolated workspace.
      </>
    ),
    title: 'Run',
  },
  {
    body: (
      <>
        At a gate <HelpTip term="gate" /> the run stops until a person approves, answers, or
        reviews.
      </>
    ),
    title: 'Gate',
  },
  {
    body: 'The finished change is opened as a pull request on your repository.',
    title: 'Pull request',
  },
  {
    body: 'No built-in step or template merges a pull request. A person reviews it and merges it.',
    title: 'You merge',
  },
];

/** A compact, collapsible overview of the request-to-merge lifecycle. */
export function HowItWorks({
  defaultOpen = false,
  className,
}: {
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details
      className={cn('group rounded-lg border border-ink-500/70 bg-ink-800/60', className)}
      open={defaultOpen}
    >
      <summary className="cursor-pointer select-none rounded-lg px-4 py-3 text-sm font-medium text-paper-100 outline-none focus-visible:ring-2 focus-visible:ring-ember-400">
        How auto-swe works
      </summary>
      <div className="border-t border-ink-600 px-4 py-4">
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((step, index) => (
            <li className="min-w-0" key={step.title}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-ember-300 tabular-nums">{index + 1}</span>
                <p className="text-sm font-semibold text-paper-100">{step.title}</p>
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-paper-400">{step.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-4">
          <DocLink label="Read the concepts guide" {...HELP_LINKS.concepts} />
        </p>
      </div>
    </details>
  );
}
