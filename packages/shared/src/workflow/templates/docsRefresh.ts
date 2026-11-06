import { DOCS_MAINTAINER_PROMPT } from '../../lib/agentPrompts.js';
import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  mergeNodes,
  openPullRequest,
  prResult,
  statusStamp,
  storeCodeResult,
  terminate,
} from './authoring/index.js';

/**
 * What the documentation step may change: markdown anywhere, and anything under `docs/`. The
 * implementer's guard refuses a change to any other path before it is committed or pushed, so a
 * prompt that is talked out of "documentation only" still cannot touch the source.
 */
export const DOCS_REFRESH_ALLOWED_PATHS = ['**/*.md', 'docs/'];

/**
 * Keep a repository's markdown documentation true to its code, or write it when it is missing.
 * Point it at a repository and put it on a schedule (a `ScheduledWorkRequest`), or start it by
 * hand; the run's description names a focus when there is one.
 *
 * The run ends at a DRAFT pull request, with no CI loop and no approval inside the run: the
 * draft is the control and a person merges. A run that changes nothing opens no pull request,
 * so a schedule that fires while the documentation is current costs one agent session and
 * leaves no noise behind.
 */
export const DOCS_REFRESH_SPEC: WorkflowSpec = {
  description:
    'Keep the repository documentation true to its code: read the markdown, check each claim ' +
    'against the source, fix what has drifted and write what is missing (a README when there ' +
    'is none), then open a draft pull request. Only markdown files or files under docs/ can change. A run with nothing ' +
    'to change opens none, so it suits a schedule.',
  entry: 'setImplementing',
  name: 'docs-refresh',
  nodes: mergeNodes(
    {
      setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
      implement: {
        config: {
          allowedPaths: DOCS_REFRESH_ALLOWED_PATHS,
          systemPrompt: DOCS_MAINTAINER_PROMPT,
        },
        group: 'implement',
        next: 'checkChanges',
        step: 'executeImplementation',
        title: 'Update the documentation',
        type: 'step',
      },
      checkChanges: {
        expr: 'nodes.implement.output.filesChanged.length == 0',
        group: 'implement',
        onFalse: 'storeCodeResult',
        onTrue: 'doneNoChange',
        title: 'Anything changed?',
        type: 'cond',
      },
      storeCodeResult: storeCodeResult('openPR', { group: 'implement' }),
    },
    openPullRequest({ draft: true, next: 'done' }),
    {
      done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Draft PR opened' }),
      // No group on the extra terminal: a second terminal in `finish` would split it in two.
      doneNoChange: terminate('SUCCESS', {
        result: { changed: { literal: false } },
        title: 'Documentation already current',
      }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
