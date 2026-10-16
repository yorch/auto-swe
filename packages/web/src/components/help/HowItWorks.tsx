import type { ReactNode } from 'react';
import { PageHelp } from '@/components/help/PageHelp';
import { DocLink } from '@/components/ui/DocLink';
import { HelpTip } from '@/components/ui/HelpTip';
import { HELP_LINKS } from '@/lib/helpLinks';

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

/**
 * The request-to-merge lifecycle, as help: it shows in the Help panel (the "?" in the top bar)
 * on any page that renders it, rather than as a block on the page.
 */
export function HowItWorks() {
  return (
    <PageHelp>
      <section aria-labelledby="how-it-works-title">
        <h3 className="text-sm font-semibold text-paper-100" id="how-it-works-title">
          How auto-swe works
        </h3>
        <ol className="mt-3 space-y-3">
          {STEPS.map((step, index) => (
            <li className="min-w-0" key={step.title}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-ember-300 tabular-nums">{index + 1}</span>
                <p className="text-sm font-semibold text-paper-100">{step.title}</p>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-paper-400">{step.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-4">
          <DocLink label="Read the concepts guide" {...HELP_LINKS.concepts} />
        </p>
      </section>
    </PageHelp>
  );
}
