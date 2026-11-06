import { proxyActivities } from '@temporalio/workflow';
import type {
  ProposeRepoSetupFileInput,
  ProposeRepoSetupFileResult,
} from '../activities/proposeRepoSetupFile.js';

/**
 * RepoSetupFileProposalWorkflow — open a pull request adding `.auto-swe/setup.yml` to a
 * repository. Started BY NAME by the gateway, which awaits the result.
 *
 * No retries: a retry after a partial run would cut a second branch and PR.
 *
 * V8-isolate rule: only `import type` from external packages / activities.
 */
const { proposeRepoSetupFile } = proxyActivities<{
  proposeRepoSetupFile(input: ProposeRepoSetupFileInput): Promise<ProposeRepoSetupFileResult>;
}>({
  retry: { maximumAttempts: 1 },
  startToCloseTimeout: '2 minutes',
});

export async function RepoSetupFileProposalWorkflow(
  input: ProposeRepoSetupFileInput
): Promise<ProposeRepoSetupFileResult> {
  return proposeRepoSetupFile(input);
}
