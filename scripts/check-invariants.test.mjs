import { describe, expect, it } from 'vitest';
import {
  autoMergeNamingViolations,
  envCredentialViolations,
  immediateMergeViolations,
  liveSuiteViolations,
  optInSuiteViolations,
  slackWriterViolations,
  workflowTriggers,
} from './check-invariants.mjs';

const PG = 'packages/gateway/src/routes/x.pg.test.ts';
const DOCKER = 'packages/worker/src/agents/y.docker.test.ts';
const gated = (flag) => `const enabled = process.env.${flag} === '1';\n`;

/** A one-job `ci.yml` whose steps are the given `[name, env, run, extra]` tuples. */
function ci(steps) {
  const body = steps
    .map(([name, env, run, extra = '']) => {
      const envBlock = env ? `        env:\n          ${env}\n` : '';
      return `      - name: ${name}\n${extra}${envBlock}        run: ${run}\n`;
    })
    .join('\n');
  return `jobs:\n  t:\n    steps:\n${body}`;
}

describe('optInSuiteViolations', () => {
  it('passes a database and a Docker suite each run with its flag set', () => {
    const yml = ci([
      ['pg', "PG_FLAG: '1'", `yarn test ${PG}`],
      ['docker', "DOCKER_FLAG: '1'", `yarn test ${DOCKER}`],
    ]);
    const suites = [
      { path: PG, src: gated('PG_FLAG') },
      { path: DOCKER, src: gated('DOCKER_FLAG') },
    ];
    expect(optInSuiteViolations(suites, yml)).toEqual([]);
  });

  it('reports a Docker suite no step runs', () => {
    const v = optInSuiteViolations([{ path: DOCKER, src: gated('DOCKER_FLAG') }], ci([]));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ file: DOCKER, invariant: 'opt-in-suites-run-in-ci' });
    expect(v[0].detail).toContain('not run by any');
  });

  it('reports a Docker suite run under the wrong flag', () => {
    const yml = ci([['docker', "OTHER_FLAG: '1'", `yarn test ${DOCKER}`]]);
    const v = optInSuiteViolations([{ path: DOCKER, src: gated('DOCKER_FLAG') }], yml);
    expect(v.map((x) => x.detail)).toEqual([
      `the step running ${DOCKER} does not set DOCKER_FLAG: '1'`,
    ]);
  });

  it('reports a Docker suite on a conditional or non-failing step', () => {
    for (const extra of [
      "        if: github.event_name == 'push'\n",
      '        continue-on-error: true\n',
    ]) {
      const yml = ci([['docker', "DOCKER_FLAG: '1'", `yarn test ${DOCKER}`, extra]]);
      const v = optInSuiteViolations([{ path: DOCKER, src: gated('DOCKER_FLAG') }], yml);
      expect(v.map((x) => x.detail)).toEqual([
        `the step running ${DOCKER} has \`if:\` or \`continue-on-error:\``,
      ]);
    }
  });

  it('refuses a suite whose gate is not the recognised form', () => {
    const yml = ci([['docker', "DOCKER_FLAG: '1'", `yarn test ${DOCKER}`]]);
    const src = 'const enabled = Boolean(process.env.DOCKER_FLAG);\n';
    const v = optInSuiteViolations([{ path: DOCKER, src }], yml);
    expect(v[0].detail).toContain('cannot find the suite');
  });

  it('ignores a suite named only in a comment', () => {
    const yml = ci([['docker', "DOCKER_FLAG: '1'", `echo skip # yarn test ${DOCKER}`]]).replace(
      `run: echo skip # yarn test ${DOCKER}`,
      `run: echo skip\n        # yarn test ${DOCKER}`
    );
    const v = optInSuiteViolations([{ path: DOCKER, src: gated('DOCKER_FLAG') }], yml);
    expect(v[0].detail).toContain('not run by any');
  });
});

describe('liveSuiteViolations', () => {
  const LIVE = 'packages/worker/src/live/z.live.test.ts';
  const live = (steps, on = '  schedule:\n    - cron: "0 5 * * *"\n  workflow_dispatch:\n') =>
    `on:\n${on}jobs:\n  t:\n    steps:\n${steps
      .map(([name, env, run, extra = '']) => {
        const envBlock = env ? `        env:\n          ${env}\n` : '';
        return `      - name: ${name}\n${extra}${envBlock}        run: ${run}\n`;
      })
      .join('\n')}`;
  const suite = { path: LIVE, src: gated('LIVE_FLAG') };

  it('passes a live suite run by a scheduled, dispatchable workflow with its flag set', () => {
    const yml = live([['z', "LIVE_FLAG: '1'", `yarn test ${LIVE}`]]);
    expect(liveSuiteViolations([suite], yml)).toEqual([]);
  });

  it('reports a live suite no step of the live workflow runs', () => {
    const v = liveSuiteViolations([suite], live([]));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ file: LIVE, invariant: 'live-suites-run-in-live-workflow' });
  });

  it('reports a live suite run under the wrong flag or on a conditional step', () => {
    const wrong = live([['z', "OTHER: '1'", `yarn test ${LIVE}`]]);
    expect(liveSuiteViolations([suite], wrong)[0].detail).toContain('does not set LIVE_FLAG');
    const cond = live([['z', "LIVE_FLAG: '1'", `yarn test ${LIVE}`, '        if: always()\n']]);
    expect(liveSuiteViolations([suite], cond)[0].detail).toContain('has `if:`');
  });

  it('is not satisfied by a step of ci.yml-style naming in the wrong pattern', () => {
    // A `.docker.test.ts` path in the live workflow does not count as running a live suite.
    const yml = live([['z', "LIVE_FLAG: '1'", 'yarn test packages/worker/src/x.docker.test.ts']]);
    expect(liveSuiteViolations([suite], yml)[0].detail).toContain('not run by any');
  });

  it('refuses a pull-request, push or caller trigger', () => {
    for (const trigger of ['pull_request', 'pull_request_target', 'push', 'workflow_call']) {
      const yml = live(
        [['z', "LIVE_FLAG: '1'", `yarn test ${LIVE}`]],
        `  schedule:\n    - cron: "0 5 * * *"\n  workflow_dispatch:\n  ${trigger}:\n`
      );
      const v = liveSuiteViolations([suite], yml);
      expect(v.map((x) => x.detail)).toEqual([
        expect.stringContaining(`triggered by \`${trigger}\``),
      ]);
    }
  });

  it('requires both a schedule and a manual trigger', () => {
    const yml = live([['z', "LIVE_FLAG: '1'", `yarn test ${LIVE}`]], '  workflow_dispatch:\n');
    expect(liveSuiteViolations([suite], yml).map((x) => x.detail)).toEqual([
      expect.stringContaining('no `schedule` trigger'),
    ]);
  });

  it('reads the triggers of a block-form on:', () => {
    expect(
      workflowTriggers(
        'on:\n  push:\n    branches: [main]\n  schedule:\n    - cron: x\nenv:\n  a: b\n'
      )
    ).toEqual(['push', 'schedule']);
    expect(workflowTriggers('name: x\n')).toBeNull();
  });
});

describe('envCredentialViolations', () => {
  // Source snippets name template placeholders as `@{x}` so no string here looks like one.
  const S = (src) => src.replaceAll('@{', '$' + '{');
  const wrap = (env) => `await backend.exec(h, ['sh'], {\n  ${env},\n  heartbeatLabel: 'x',\n});\n`;

  it('passes an env list of non-secret pairs, and secretEnv', () => {
    expect(envCredentialViolations(wrap('env: [tag.env]'))).toEqual([]);
    const tagged = S('env: [`@{EXEC_TAG_ENV}=@{tag}`, ...extra]');
    expect(envCredentialViolations(wrap(tagged))).toEqual([]);
    expect(envCredentialViolations(wrap('secretEnv: { ASW_GIT_AUTH: header }'))).toEqual([]);
  });

  it('reports a credential-shaped name in a string, template or identifier', () => {
    for (const env of [
      "env: ['GITHUB_TOKEN=abc']",
      S('env: [`AUTO_SWE_NPMRC=@{npmrc}`]'),
      S('env: [`X=@{apiKey}`]'),
      "env: ['A=1', 'Authorization=Bearer x']",
    ]) {
      expect(envCredentialViolations(wrap(env)), env).toHaveLength(1);
    }
  });

  it('reports an env assignment, a quoted key and leadingEnv', () => {
    for (const src of [
      S('spec.env = [...(spec.env ?? []), `YARN_NPM_AUTH_TOKEN=@{t}`];'),
      "run({ 'env': ['GITHUB_TOKEN=x'] });",
      S('turn.spawn({ leadingEnv: [`GITHUB_TOKEN=@{t}`] });'),
    ]) {
      expect(envCredentialViolations(src), src).toHaveLength(1);
    }
  });

  it('does not report names that only contain a credential word', () => {
    for (const env of [
      "env: ['GIT_AUTHOR_NAME=x']",
      "env: ['CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000']",
    ]) {
      expect(envCredentialViolations(wrap(env)), env).toEqual([]);
    }
    expect(envCredentialViolations(wrap("env: ['MAX_TOKENS=1', 'API_TOKEN=x']"))).toHaveLength(1);
    // `AUTHOR` is excluded, but it is the front of `AUTHORIZATION`, which is a credential.
    expect(envCredentialViolations(wrap("env: ['AUTHORIZATION=x']"))).toHaveLength(1);
    const mixed = wrap("env: ['GIT_AUTHOR_EMAIL=x', 'Authorization=y']");
    expect(envCredentialViolations(mixed)).toHaveLength(1);
  });

  it('reports the widened credential words, and whole-word PAT, PASS and PWD only', () => {
    for (const env of [
      "env: ['DEPLOY_SSH_KEY=x']",
      "env: ['AWS_ACCESS_KEY=x']",
      "env: ['SSH_PRIVATE_KEY=x']",
      "env: ['SESSION_COOKIE=x']",
      "env: ['AUTH_BEARER=x']",
      "env: ['GITHUB_PAT=x']",
      "env: ['DB_PASS=x']",
      "env: ['DB_PWD=x']",
    ]) {
      expect(envCredentialViolations(wrap(env)), env).toHaveLength(1);
    }
    const plain = wrap(
      "env: ['PASSIVE_MODE=1', 'PATH=/x', 'COMPASS_DIR=/y', 'OLDPWD=/z', 'BYPASS=1', 'PATCH=2']"
    );
    expect(envCredentialViolations(plain)).toEqual([]);
  });

  it('reports a bare PAT, PASS or PWD at the start of a string literal', () => {
    for (const env of [
      "env: ['PAT=x']",
      S('env: [`PWD=@{p}`]'),
      "env: ['PASS=x']",
      "env: ['GPG_PASSPHRASE=x']",
      "env: ['DEPLOY_KEY=x']",
      "env: ['SIGNING_KEY=x']",
    ]) {
      expect(envCredentialViolations(wrap(env)), env).toHaveLength(1);
    }
  });

  it('does not report platform env names', () => {
    const names = [
      'NPM_CONFIG_USERCONFIG',
      'NPM_CONFIG_REPLACE_REGISTRY_HOST',
      'NPM_CONFIG_AUDIT',
      'NPM_CONFIG_FUND',
      'NPM_CONFIG_UPDATE_NOTIFIER',
      'NPM_CONFIG_REGISTRY',
      'YARN_NPM_REGISTRY_SERVER',
      'COREPACK_NPM_REGISTRY',
      'COREPACK_ENABLE_DOWNLOAD_PROMPT',
      'YARN_NPM_ALWAYS_AUTH',
      'AUTO_SWE_EXEC_ID',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_MAX_RETRIES',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'HOME',
      'SHELL',
      'DISABLE_AUTOUPDATER',
      'DISABLE_TELEMETRY',
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'CONTAINER_STEP_INPUT',
      'PATH',
      'LANG',
      'TERM',
    ];
    // YARN_NPM_ALWAYS_AUTH is an exact-name exception at run time only; the source rule has none.
    for (const name of names.filter((n) => n !== 'YARN_NPM_ALWAYS_AUTH')) {
      expect(envCredentialViolations(wrap(`env: ['${name}=x']`)), name).toEqual([]);
    }
  });

  it('does not treat a comparison or another property as an env assignment', () => {
    expect(envCredentialViolations('if (x.env == [`TOKEN`]) {}')).toEqual([]);
  });

  it('reports the line of the env property', () => {
    expect(envCredentialViolations(wrap("env: ['MY_SECRET=x']"))[0].line).toBe(2);
  });

  it('ignores a credential name in a comment, a sibling property, or a nested array', () => {
    expect(envCredentialViolations(S('// env: [`TOKEN=@{t}`]\nconst a = 1;'))).toEqual([]);
    expect(envCredentialViolations(wrap('env: [tag.env], token: t'))).toEqual([]);
    expect(envCredentialViolations(S('const x = { sudoenv: [`TOKEN=@{t}`] };'))).toEqual([]);
  });

  it('does not see an env built elsewhere (a documented gap)', () => {
    const src = S('const pairs = [`TOKEN=@{t}`];\nrun({ env: pairs });');
    expect(envCredentialViolations(src)).toEqual([]);
  });
});

describe('immediateMergeViolations', () => {
  it('passes auto-merge and source with no merge call', () => {
    const src =
      "await octokit.graphql('mutation { enablePullRequestAutoMerge(input: {}) { x } }');";
    expect(immediateMergeViolations(src)).toEqual([]);
    expect(immediateMergeViolations('const merged = pr.merged;\n')).toEqual([]);
  });

  it('reports pulls.merge, the REST merge route and the GraphQL mutation', () => {
    for (const src of [
      'await octokit.pulls.merge({ pull_number: 1 });',
      'await octokit.rest.pulls .merge ({ pull_number: 1 });',
      "await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {});",
      "await octokit.graphql('mutation { mergePullRequest(input: {}) { x } }');",
    ]) {
      expect(immediateMergeViolations(src)).toHaveLength(1);
    }
  });

  it('reports the other immediate-merge spellings', () => {
    for (const src of [
      'await octokit.repos.merge({ base: "main", head: "x" });',
      'await octokit.rest.repos .merge ({});',
      "await octokit.repos['merge']({});",
      'await octokit.rest.pulls["merge"]({});',
      "await octokit.request('POST /repos/{owner}/{repo}/merges', {});",
      "await fetch(api + '/repos/acme/api/merges', { method: 'POST' });",
      "await octokit.graphql('mutation { enqueuePullRequest(input: {}) { x } }');",
      "await octokit.graphql('mutation { mergeBranch(input: {}) { x } }');",
      "await exec('git push origin HEAD:main');",
      "await exec('git push origin HEAD:refs/heads/master');",
      "await exec('git push --force origin HEAD:main');",
    ]) {
      expect(immediateMergeViolations(src), src).toHaveLength(1);
    }
  });

  it('does not flag a push of a feature branch or an unrelated merge word', () => {
    for (const src of [
      "await exec('git push origin HEAD:auto/JIRA-1');",
      "await exec('git push origin HEAD:mainline');",
      'const merges = list.filter(Boolean);',
      "await octokit.request('GET /repos/{owner}/{repo}/merges-list');",
      'await git.merge(branch);',
      'await mergeBranchNames(a, b);',
    ]) {
      expect(immediateMergeViolations(src), src).toEqual([]);
    }
  });

  it('reports the line, and ignores comments', () => {
    expect(immediateMergeViolations('a;\nawait c.pulls.merge({});\n')[0]?.line).toBe(2);
    expect(immediateMergeViolations('// never call pulls.merge( here\n')).toEqual([]);
    expect(immediateMergeViolations('/* mergePullRequest */\n')).toEqual([]);
  });
});

describe('autoMergeNamingViolations', () => {
  const NAMES = 'await scm.enableAutoMerge(repo, 1, opts);\n';
  it.each([
    'packages/worker/src/activities/evaluatePullRequest.ts',
    'packages/worker/src/lib/scm/github.ts',
    'packages/worker/src/lib/scm/types.ts',
  ])('lets %s name the mutation', (file) => {
    expect(autoMergeNamingViolations(file, NAMES)).toEqual([]);
  });

  it('reports any other file naming either spelling, with its line', () => {
    const src =
      'a;\nawait scm.enableAutoMerge(r, 1);\nq("mutation { enablePullRequestAutoMerge }");\n';
    expect(autoMergeNamingViolations('packages/gateway/src/routes/x.ts', src)).toEqual([
      { line: 2, text: 'await scm.enableAutoMerge(r, 1);' },
      { line: 3, text: 'q("mutation { enablePullRequestAutoMerge }");' },
    ]);
  });

  it('ignores comments and longer identifiers', () => {
    const src = '// enableAutoMerge is not called here\nconst enableAutoMergeLater = 1;\n';
    expect(autoMergeNamingViolations('packages/worker/src/other.ts', src)).toEqual([]);
  });
});

describe('slackWriterViolations', () => {
  const NOTIFY = 'packages/worker/src/lib/slackNotify.ts';
  const OTHER = 'packages/worker/src/activities/somethingNew.ts';
  const post = "await fetch('https://slack.com/api/chat.postMessage', { method: 'POST' });";

  it('lets the known writers name the endpoints', () => {
    for (const file of [
      'packages/gateway/src/lib/slack.ts',
      'packages/gateway/src/lib/hitlSlackSync.ts',
      'packages/worker/src/connectors/slack.ts',
    ]) {
      expect(slackWriterViolations(file, post), file).toEqual([]);
    }
  });

  it('reports any other file that names chat.postMessage or chat.update', () => {
    for (const src of [
      post,
      "const url = 'https://slack.com/api/chat.update';",
      "await slackApi(connection, '/chat.postMessage', body);",
    ]) {
      expect(slackWriterViolations(OTHER, src), src).toHaveLength(1);
    }
  });

  it('ignores a mention in a comment and unrelated Slack endpoints', () => {
    const src = [
      '// we used to call chat.postMessage here',
      '/** posts through chat.update */',
      "await fetch('https://slack.com/api/conversations.replies');",
      "await fetch('https://slack.com/api/views.open');",
    ].join('\n');
    expect(slackWriterViolations(OTHER, src)).toEqual([]);
  });

  it('passes slackNotify.ts when every send is matched by a neutralize call', () => {
    const src = [
      "const A = 'https://slack.com/api/chat.postMessage';",
      'await fetch(SLACK_POST_URL, { body: neutralizeSlackBroadcasts(a) });',
      'await fetch(SLACK_UPDATE_URL, { body: neutralizeSlackBroadcasts(b) });',
      'await fetch(SLACK_POST_URL, { body: neutralizeSlackBroadcasts(c) });',
    ].join('\n');
    expect(slackWriterViolations(NOTIFY, src)).toEqual([]);
  });

  it('reports slackNotify.ts when a send is not matched', () => {
    const src = [
      'await fetch(SLACK_POST_URL, { body: neutralizeSlackBroadcasts(a) });',
      'await fetch(SLACK_UPDATE_URL, { body: JSON.stringify({ text }) });',
    ].join('\n');
    const found = slackWriterViolations(NOTIFY, src);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('unneutralized-send');
  });

  it('does not count a neutralize call that sits in a comment', () => {
    const src = [
      '// neutralizeSlackBroadcasts(text) is applied below',
      'await fetch(SLACK_POST_URL, { body: JSON.stringify({ text }) });',
    ].join('\n');
    expect(slackWriterViolations(NOTIFY, src)).toHaveLength(1);
  });
});
