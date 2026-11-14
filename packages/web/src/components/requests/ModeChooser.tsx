'use client';

import { Button } from '@/components/ui/Button';

export type WorkMode = 'workflow' | 'agent' | 'epic' | 'prd';

export interface ModeChoice {
  mode: WorkMode;
  question: string;
  /** Absent when this person cannot start the mode: the row explains instead of offering it. */
  action?: string;
  note?: string;
}

/**
 * The decision list for "Not sure?". An epic is offered only to a team lead or administrator
 * (POST /epics requires LEAD on each owning team); below that the row says so and offers no control, so nobody is
 * steered towards a mode they cannot launch.
 */
export function modeChoices(canStartEpic: boolean, epicReason?: string): ModeChoice[] {
  return [
    {
      action: 'Pick a workflow',
      mode: 'workflow',
      question: 'A process in the workflow library fits the job.',
    },
    {
      action: 'Run an agent',
      mode: 'agent',
      question: 'You want one agent to do one focused task on a single repository.',
    },
    canStartEpic
      ? {
          action: 'Run an epic',
          mode: 'epic',
          question: 'The change spans several repositories.',
        }
      : {
          mode: 'epic',
          note: `${epicReason ?? 'Only team leads and administrators can start an epic.'} For several repositories, ask one, or start a workflow or an agent on each repository separately.`,
          question: 'The change spans several repositories.',
        },
    canStartEpic
      ? {
          action: 'Run from a PRD',
          mode: 'prd',
          question: 'You have a product requirements document to break into stories.',
        }
      : {
          mode: 'prd',
          note: epicReason ?? 'Only team leads and administrators can start a PRD run.',
          question: 'You have a product requirements document to break into stories.',
        },
  ];
}

export function ModeChooser({
  canStartEpic,
  current,
  epicReason,
  onChoose,
}: {
  canStartEpic: boolean;
  /** Why an epic is not offered, when it is not; replaces the generic role sentence. */
  epicReason?: string;
  current: WorkMode;
  onChoose: (mode: WorkMode) => void;
}) {
  return (
    <section
      aria-labelledby="mode-chooser-title"
      className="rounded-xl border border-ink-500/70 bg-ink-900/40 p-4"
      data-testid="mode-hint"
    >
      <p className="text-sm font-medium text-paper-300" id="mode-chooser-title">
        Not sure? Pick the line that matches your task.
      </p>
      <ul className="mt-3 space-y-3">
        {modeChoices(canStartEpic, epicReason).map((choice) => (
          <li
            className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
            key={choice.mode}
          >
            <p className="min-w-0 text-sm leading-relaxed text-paper-400">
              {choice.question}
              {choice.note && <span className="mt-0.5 block text-paper-500">{choice.note}</span>}
            </p>
            {choice.action && (
              <Button
                aria-pressed={current === choice.mode}
                onClick={() => onChoose(choice.mode)}
                size="sm"
                variant={current === choice.mode ? 'primary' : 'secondary'}
              >
                {choice.action}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
