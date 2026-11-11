import { describe, expect, it } from 'vitest';
import {
  autoMergeNamingViolations,
  bareFetchViolations,
  connectorFetchRedirectViolations,
  envCredentialViolations,
  IMMEDIATE_MERGE_PROVIDER_ALLOWLIST,
  immediateMergeViolations,
  isScmProviderFile,
  liveSuiteViolations,
  optInSuiteViolations,
  providerCodeOutsideScmViolations,
  scmProviderFiles,
  slackWriterViolations,
  stripComments,
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

/** Spell a template interpolation without tripping a lint rule: <<id>> becomes dollar-brace id. */
const tpl = (s) => s.replace(/<<([^>]*)>>/g, (_, e) => ['$', '{', e, '}'].join(''));

describe('immediateMergeViolations: GitLab and Bitbucket', () => {
  it('reports the REST merge routes in literal, placeholder and interpolated forms', () => {
    for (const src of [
      "put('/projects/1/merge_requests/2/merge');",
      "await gl.request(`/projects/<<id>>/merge_requests/<<iid>>/merge`, { method: 'PUT' });",
      'await gl.request(`/projects/<<id>>/merge_requests/<<a + b>>/merge`, {});',
      "await http.put('/projects/{id}/merge_requests/{merge_request_iid}/merge');",
      'await bb.post(`/repositories/<<w>>/<<r>>/pullrequests/<<id>>/merge`);',
      "await bb.post('/repositories/acme/api/pullrequests/{pull_request_id}/merge');",
      "await bb.post('/projects/P/repos/r/pull-requests/4/merge');",
    ]) {
      expect(immediateMergeViolations(tpl(src)), src).toHaveLength(1);
    }
  });

  it('reports auto-merge-on-pipeline options, accept/merge names and clients', () => {
    for (const src of [
      'body: { merge_when_pipeline_succeeds: true },',
      'const opts = { mergeWhenPipelineSucceeds: true };',
      'await gl.acceptMergeRequest(1, 2);',
      'await gl.accept_merge_request(1, 2)',
      'await gl.mergeMergeRequest(1, 2);',
      "await q('mutation { mergeRequestAccept(input: {}) { x } }');",
      'await gl.MergeRequests.accept(1, 2);',
      'await gl.MergeRequests.merge(1, 2);',
      'await client.merge_requests.merge(1);',
      "await client.mergeRequests['accept'](1);",
      'await bitbucket.pullrequests.merge({});',
    ]) {
      expect(immediateMergeViolations(tpl(src)), src).toHaveLength(1);
    }
  });

  it('does not flag cancelling a merge, unrelated routes, or lookalike names', () => {
    for (const src of [
      "put('/projects/1/merge_requests/2/cancel_merge_when_pipeline_succeeds');",
      'get(`/projects/<<id>>/merge_requests/<<iid>>/changes`);',
      "get('/projects/1/merge_requests/2/merge_ref');",
      "get('/repositories/a/b/pullrequests/3/commits');",
      "post('/repositories/a/b/pullrequests/3/approve');",
      'await gl.cancelMergeWhenPipelineSucceeds(1, 2);',
      'const mergeRequests = list.filter(Boolean);',
      'await gl.MergeRequests.show(1, 2);',
      'await client.merge_requests.create({});',
    ]) {
      expect(immediateMergeViolations(tpl(src)), src).toEqual([]);
    }
  });

  it('ignores comments', () => {
    expect(immediateMergeViolations('// PUT /merge_requests/1/merge is forbidden\n')).toEqual([]);
    expect(immediateMergeViolations('/* merge_when_pipeline_succeeds */\n')).toEqual([]);
  });
});

describe('bareFetchViolations', () => {
  it('reports a call, a default parameter and a passed value, with the line', () => {
    expect(bareFetchViolations("a;\nawait fetch('https://x');\n")).toEqual([{ line: 2 }]);
    expect(bareFetchViolations('function f(impl = fetch) {}\n')).toHaveLength(1);
    expect(bareFetchViolations('run(globalThis.fetch);\n')).toHaveLength(1);
    expect(bareFetchViolations('use(fetch);\n')).toHaveLength(1);
  });

  it('passes a guarded fetch, a type, a property key, comments and prose', () => {
    for (const src of [
      'const f = createGuardedFetch(); await f(url);\n',
      'type F = typeof fetch;\n',
      'const o = { fetch: impl };\n',
      '// fetch( is banned here\n',
      "throw new Error('Cannot fetch CI logs');\n",
      'await fetchGuarded(url, {});\n',
    ]) {
      expect(bareFetchViolations(src), src).toEqual([]);
    }
  });
});

describe('connectorFetchRedirectViolations', () => {
  it('reports a fetch call that states no redirect policy', () => {
    expect(connectorFetchRedirectViolations("a;\nawait fetch(url, { method: 'GET' });\n")).toEqual([
      { line: 2 },
    ]);
    expect(connectorFetchRedirectViolations('await globalThis.fetch(url);\n')).toHaveLength(1);
  });

  it('passes a call that states one, and a commented-out call', () => {
    expect(connectorFetchRedirectViolations("await fetch(url, { redirect: 'error' });\n")).toEqual(
      []
    );
    expect(connectorFetchRedirectViolations('// await fetch(url);\n')).toEqual([]);
  });
});

describe('scmProviderFiles', () => {
  it('globs the SCM seam directory, without the interface, the dispatcher or tests', () => {
    const files = scmProviderFiles();
    expect(files).toContain('packages/worker/src/lib/scm/github.ts');
    expect(files).not.toContain('packages/worker/src/lib/scm/types.ts');
    expect(files).not.toContain('packages/worker/src/lib/scm/index.ts');
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
    expect(files.every(isScmProviderFile)).toBe(true);
  });
});

describe('isScmProviderFile', () => {
  const D = 'packages/worker/src/lib/scm';
  it('covers nested directories, their index/types files and every JS/TS extension', () => {
    for (const f of [
      `${D}/github.ts`,
      `${D}/gitlab/index.ts`,
      `${D}/gitlab/types.ts`,
      `${D}/gitlab/client.ts`,
      `${D}/gitlab.mts`,
      `${D}/gitlab.cts`,
      `${D}/gitlab.js`,
      `${D}/gitlab.mjs`,
      `${D}/gitlab.cjs`,
      `${D}/gitlab.jsx`,
      `${D}/gitlab.tsx`,
      `${D}/deep/er/bitbucket/types.ts`,
    ]) {
      expect(isScmProviderFile(f), f).toBe(true);
    }
  });

  it('exempts exactly the seam interface and dispatcher, by full path', () => {
    expect(isScmProviderFile(`${D}/types.ts`)).toBe(false);
    expect(isScmProviderFile(`${D}/index.ts`)).toBe(false);
    // The same basenames elsewhere are NOT exempt — the old rule dropped them at any depth.
    expect(isScmProviderFile(`${D}/gitlab/index.ts`)).toBe(true);
    expect(isScmProviderFile(`${D}/gitlab/types.ts`)).toBe(true);
  });

  it('excludes tests, other file types and files outside the seam', () => {
    for (const f of [
      `${D}/gitlab.test.ts`,
      `${D}/gitlab.spec.ts`,
      `${D}/gitlab.test.mjs`,
      `${D}/gitlab/client.test.ts`,
      `${D}/README.md`,
      `${D}/schema.json`,
      'packages/worker/src/lib/other/gitlab.ts',
      'packages/gateway/src/lib/scm/gitlab.ts',
    ]) {
      expect(isScmProviderFile(f), f).toBe(false);
    }
  });
});

describe('immediateMergeViolations: other providers and pushes', () => {
  it('reports pushes of any default-branch name, bare, interpolated or in an argv array', () => {
    for (const src of [
      "await exec('git push origin main');",
      "await exec('git push -u origin master');",
      "await exec('git push origin HEAD:trunk');",
      "await exec('git push origin HEAD:develop');",
      "await exec('git push --force origin HEAD:development');",
      'await exec(`git push origin HEAD:<<defaultBranch>>`);',
      'await exec(`git push origin <<repo.defaultBranch>>`);',
      'await exec(`git push origin HEAD:<<baseBranch>>`);',
      "spawn('git', ['push', 'origin', 'HEAD:main']);",
      "spawn('git', ['push', '--force', 'origin', 'HEAD:refs/heads/master']);",
      "spawn('git', ['push', 'origin', 'main']);",
      "spawn('git', ['push', 'origin', 'HEAD:trunk']);",
      'spawn(`git`, [`push`, `origin`, `HEAD:<<defaultBranch>>`]);',
      "spawn('git', ['push', 'origin', defaultBranch]);",
      "spawn('git', [\n  'push',\n  'origin',\n  'HEAD:main',\n]);",
    ]) {
      expect(immediateMergeViolations(tpl(src)), src).toHaveLength(1);
    }
  });

  it('does not flag pushing a feature branch', () => {
    for (const src of [
      "await exec('git push origin HEAD:auto/JIRA-1');",
      "await exec('git push -u origin auto/main-fix');",
      'await exec(`git push origin HEAD:<<branch>>`);',
      "spawn('git', ['push', 'origin', 'HEAD:auto/x']);",
      "spawn('git', ['push', 'origin', branch]);",
      "spawn('git', ['fetch', 'origin', 'main']);",
      "await exec('git fetch origin main');",
    ]) {
      expect(immediateMergeViolations(tpl(src)), src).toEqual([]);
    }
  });

  it('reports Gerrit submit, Azure completion and a singular mergeRequest client', () => {
    for (const src of [
      'await post(`<<base>>/a/changes/<<id>>/submit`);',
      'await post(`<<base>>/a/changes/<<id>>/revisions/current/submit`);',
      "await post('/changes/1/revisions/2/submit');",
      "await fetch(`<<b>>/_apis/git/repositories/<<r>>/pullrequests/<<id>>`, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) });",
      "await patch('/pullrequests/4', { status: 'completed', lastMergeSourceCommit });",
      "const body = { status: 'completed' }; await patch(`<<u>>/pullrequests/<<id>>`, body);",
      'await gitApi.updatePullRequest({ status: 3 }, repoId, prId);',
      'const s = PullRequestStatus.Completed;',
      'await gl.mergeRequest.merge(pid, iid);',
      'await gl.MergeRequest.accept(pid, iid);',
      'await gitApi.updatePullRequest({ completionOptions: { mergeStrategy: 1 } }, repoId, prId);',
    ]) {
      expect(immediateMergeViolations(tpl(src)), src).toHaveLength(1);
    }
  });

  it('does not flag Gerrit reads, Azure non-completion or lookalikes', () => {
    for (const src of [
      'await get(`<<base>>/a/changes/<<id>>/revisions/current/submit_preview`);',
      'await get(`<<base>>/a/changes/<<id>>/submitted_together`);',
      "await patch('/pullrequests/4', { status: 'abandoned' });",
      "await octokit.checks.update({ status: 'completed' });",
      "await patch('/pullrequests/4', { autoCompleteSetBy: { id } });",
      'await gl.mergeRequest.show(pid, iid);',
    ]) {
      expect(immediateMergeViolations(tpl(src)), src).toEqual([]);
    }
  });

  it('reads a template literal that wraps inside its interpolation as one route', () => {
    const wrapped = 'await gl.put(`/projects/<<id>>/merge_requests/<<\n  iid\n>>/merge`);';
    expect(immediateMergeViolations(tpl(wrapped))).toEqual([
      {
        line: 1,
        text: `${tpl('await gl.put(`/projects/<<id>>/merge_requests/')}${['$', '{'].join('')}`,
      },
    ]);
  });

  it('does not flag merge-base, merge_ref, Bitbucket task-status or GET reads', () => {
    for (const src of [
      'get(`/projects/<<id>>/merge_requests/<<iid>>/merge-base`);',
      "get('/projects/1/merge_requests/2/merge_ref');",
      'get(`<<base>>/pullrequests/<<id>>/merge/task-status/<<task>>`);',
      'await http.get(`<<base>>/pull-requests/<<id>>/merge`);',
      "await fetch(`<<b>>/pullrequests/<<id>>/merge`, { method: 'GET', redirect: 'error' });",
    ]) {
      expect(immediateMergeViolations(tpl(src)), src).toEqual([]);
    }
  });

  it('still flags the merge itself next to a read', () => {
    expect(
      immediateMergeViolations(
        tpl("await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge');")
      )
    ).toHaveLength(1);
    expect(
      immediateMergeViolations(tpl('await bb.post(`<<base>>/pullrequests/<<id>>/merge`);'))
    ).toHaveLength(1);
    expect(
      immediateMergeViolations(
        tpl("get('/x/merge_requests/1/merge-base');\nput('/p/merge_requests/1/merge');")
      )
    ).toEqual([{ line: 2, text: "put('/p/merge_requests/1/merge');" }]);
  });

  it('honours the provider allowlist for provider spellings only, and only for scm files', () => {
    const file = 'packages/worker/src/lib/scm/gitlab.ts';
    const gl = "put('/projects/1/merge_requests/2/merge');";
    const gh = "await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge');";
    const push = "await exec('git push origin HEAD:main');";
    expect(IMMEDIATE_MERGE_PROVIDER_ALLOWLIST.size).toBe(0);
    expect(immediateMergeViolations(gl, file)).toHaveLength(1);
    const allow = new Set([file]);
    expect(immediateMergeViolations(gl, file, allow)).toEqual([]);
    // GitHub spellings and pushes are never exempt, nor is another file.
    expect(immediateMergeViolations(gh, file, allow)).toHaveLength(1);
    expect(immediateMergeViolations(push, file, allow)).toHaveLength(1);
    expect(
      immediateMergeViolations(gl, 'packages/worker/src/lib/scm/other.ts', allow)
    ).toHaveLength(1);
    // An allowlist entry outside the seam is ignored.
    const outside = 'packages/gateway/src/lib/x.ts';
    expect(immediateMergeViolations(gl, outside, new Set([outside]))).toHaveLength(1);
  });
});

// Spell the pieces a test source needs without tripping a lint rule on the literals.
const BT = '`';
const DOLLAR_BRACE = ['$', '{'].join('');

describe('immediateMergeViolations: pushes in every spelling', () => {
  it('reports a default-branch push through gitAuthed, git -C / -c, quotes and interpolation', () => {
    for (const src of [
      'await ws.gitAuthed(`push origin HEAD:main`);',
      'await ws.gitAuthed(`push origin <<sha>>:refs/heads/<<defaultBranch>>`);',
      'await ws.gitAuthed(`push origin <<shellQuote(`<<sha>>:refs/heads/<<repo.defaultBranch>>`)>>`);',
      'await exec(`git -C /workspace/target-repo push origin HEAD:main`);',
      'await exec(`git -c http.extraheader=x push origin HEAD:main`);',
      'await exec(`git -c http.extraheader=x -C dir push --force origin HEAD:master`);',
      "await exec(`git push origin 'HEAD':'main'`);",
      'await exec(\'git push origin "HEAD":"refs/heads/main"\');',
      "await exec(`git -c 'http.extraheader=Authorization: x' push origin HEAD:main`);",
      'await ws.gitAuthed(`push origin main`);',
      "await ws.gitAuthed('push -u origin main');",
      "await run('echo ok; git push origin HEAD:main');",
      'await run(`git fetch origin && git push origin HEAD:main`);',
    ]) {
      expect(immediateMergeViolations(tpl(src)), src).toHaveLength(1);
    }
  });

  it('keeps the work-branch and sha-pinned pushes clean', () => {
    for (const src of [
      'await ws.gitAuthed(`push origin HEAD:refs/heads/<<branch>>`);',
      'await ws.gitAuthed(`push origin <<shellQuote(`<<commit.sha>>:refs/heads/<<branch>>`)>>`);',
      'await exec(`git push origin <<branch>> --force-with-lease=<<branch>>:<<baseSha>>`);',
      'await exec(`git -C dir push origin HEAD:refs/heads/<<workBranch>>`);',
      'await exec(`git merge-base origin/<<defaultBranch>> HEAD`);',
      'await exec(`git fetch origin main && git push origin <<branch>>`);',
      'await exec(`git push origin <<branch>> && git checkout main`);',
      'await exec(`git push origin <<branch>>; git checkout main`);',
      'await exec(`git push origin <<branch>> | tee log; echo main`);',
      "log('git push failed; will retry from main loop');",
      'items.push(a, main);',
      'items.push(`x`, <<defaultBranch>>);',
    ]) {
      expect(immediateMergeViolations(tpl(src)), src).toEqual([]);
    }
  });

  it('is not hidden or faked by a trailing comment', () => {
    expect(
      immediateMergeViolations("await exec('git push origin HEAD:main'); // fine\n")
    ).toHaveLength(1);
    expect(
      immediateMergeViolations("await exec('git push origin x'); // git push origin main\n")
    ).toEqual([]);
    expect(
      immediateMergeViolations(
        tpl("await fetch(`<<api>>/repos/o/r/pulls/1/merge`, { method: 'PUT' }); // GET\n")
      )
    ).toHaveLength(1);
  });
});

describe('immediateMergeViolations: the GET exemption', () => {
  const ghCall = (opts) =>
    tpl(`await fetch(\`<<api>>/repos/<<o>>/<<r>>/pulls/<<n>>/merge\`, ${opts});`);

  it('never exempts the GitHub REST merge spellings', () => {
    for (const src of [
      ghCall("{ method: 'GET' }"),
      ghCall("{ method: 'PUT', headers: { 'x-orig-method': 'GET' } }"),
      ghCall("{ method: 'PUT', meta: { method: 'GET' } }"),
      "await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/merge');",
      tpl(
        "await octokit.request('PUT ' + cache.get('k', `/repos/<<o>>/<<r>>/pulls/<<n>>/merge`));"
      ),
      "await octokit.request('GET /repos/{owner}/{repo}/merges');",
    ]) {
      expect(immediateMergeViolations(src), src).toHaveLength(1);
    }
  });

  const glCall = (opts) =>
    tpl(`await fetch(\`<<b>>/projects/<<id>>/merge_requests/<<iid>>/merge\`, ${opts});`);

  it('exempts a non-GitHub route only for one top-level GET method key', () => {
    for (const src of [
      glCall("{ method: 'GET', redirect: 'error' }"),
      glCall("{ redirect: 'error', 'method': 'get' }"),
      glCall("{ headers: { 'x-orig-method': 'PUT' }, method: 'GET' }"),
      "await octokit.request('GET /projects/1/merge_requests/2/merge');",
      tpl('await http.get(`<<b>>/projects/<<id>>/merge_requests/<<iid>>/merge`);'),
      tpl(
        'const r = await client.get(`<<b>>/projects/<<id>>/merge_requests/<<iid>>/merge`, { a: 1 });'
      ),
    ]) {
      expect(immediateMergeViolations(src), src).toEqual([]);
    }
  });

  it('does not let a nested, header-named, repeated or absent method key pose as a GET', () => {
    for (const src of [
      glCall("{ method: 'PUT', headers: { 'x-orig-method': 'GET' } }"),
      glCall("{ method: 'PUT', meta: { method: 'GET' } }"),
      glCall("{ method: 'PUT', method: 'GET' }"),
      glCall("{ method: 'GET', method: 'PUT' }"),
      glCall('{ method: verb }'),
      glCall("{ 'x-method': 'GET', method: 'PUT' }"),
      glCall("{ method: 'PUT' }"),
      tpl(
        "await octokit.request('PUT ' + cache.get('k', `<<b>>/projects/<<id>>/merge_requests/<<iid>>/merge`));"
      ),
      tpl(
        "await call({ method: 'POST', url: `<<b>>/projects/<<id>>/merge_requests/<<iid>>/merge` });"
      ),
    ]) {
      expect(immediateMergeViolations(src), src).toHaveLength(1);
    }
  });
});

describe('immediateMergeViolations: Azure updatePullRequest', () => {
  it('does not flag GitHub non-merging updatePullRequest or a bare updatePullRequest', () => {
    for (const src of [
      tpl(
        'const q = `mutation { updatePullRequest(input: {pullRequestId: $id, title: $t}) { pullRequest { id } } }`;'
      ),
      'await api.updatePullRequest({ title: t }, repoId, prId);',
      "await octokit.rest.pulls.update({ state: 'closed' }); // updatePullRequest",
    ]) {
      expect(immediateMergeViolations(src), src).toEqual([]);
    }
  });

  it('flags updatePullRequest beside a completing shape, in either order', () => {
    for (const src of [
      'await gitApi.updatePullRequest({ status: 3 }, repoId, prId);',
      "await gitApi.updatePullRequest({ status: 'completed' }, repoId, prId);",
      'await gitApi.updatePullRequest({ completionOptions: { deleteSourceBranch: true } }, r, p);',
      'const body = { status: PullRequestStatus.Completed };\nawait gitApi.updatePullRequest(body, r, p);',
    ]) {
      expect(immediateMergeViolations(src), src.slice(0, 60)).toHaveLength(1);
    }
  });
});

describe('stripComments', () => {
  it('keeps length and newlines, blanking only comments', () => {
    const src = 'a; // x\n/* y\nz */ b;\n';
    expect(stripComments(src)).toHaveLength(src.length);
    expect(stripComments(src).split('\n')).toHaveLength(src.split('\n').length);
    expect(stripComments(src).replace(/\s+/g, ' ').trim()).toBe('a; b;');
  });

  it('does not treat a slash-star inside a string, template or regex as a comment', () => {
    for (const src of [
      "const g = 'packages/*/src'; keep();",
      'const g = "src/*"; keep();',
      'const g = `src/*`; keep();',
      `const g = ${BT}a/${DOLLAR_BRACE}x}/*${BT}; keep();`,
      `const g = ${BT}${DOLLAR_BRACE}${BT}inner/*${BT}}${BT}; keep();`,
      'const re = /src\\/*/; keep();',
      "const g = ['a/*', 'b/*']; keep();",
    ]) {
      const out = stripComments(`${src}\nconst h = '*/';`);
      expect(out, src).toContain('keep();');
      expect(out, src).toContain("'*/'");
    }
  });

  it('removes real comments after strings, and keeps URLs inside strings', () => {
    expect(stripComments("a('x'); // drop me")).not.toContain('drop');
    expect(stripComments("a('x'); /* drop */ b();")).toContain('b();');
    expect(stripComments("a('x'); /* drop */ b();")).not.toContain('drop');
    expect(stripComments("const u = 'https://example.com/a'; // c")).toContain(
      'https://example.com/a'
    );
    expect(stripComments(`const u = ${BT}http://x/${DOLLAR_BRACE}a}${BT}; // c`)).toContain(
      'http://x/'
    );
  });

  it('keeps an apostrophe in a comment from opening a string', () => {
    expect(stripComments("// don't\nfetch('/pulls/1/merge');")).toContain(
      "fetch('/pulls/1/merge');"
    );
  });

  it('lets the rules see a call that follows a glob string and precedes a closing star-slash', () => {
    const merge = `const g = 'src/*'; await fetch(${BT}${DOLLAR_BRACE}api}/repos/o/r/pulls/1/merge${BT}, {method:'PUT'}); const h = '*/';`;
    expect(immediateMergeViolations(merge)).toHaveLength(1);
    expect(
      providerCodeOutsideScmViolations(
        'packages/gateway/src/lib/x.ts',
        `const g = 'a/*'; const u = ${BT}${DOLLAR_BRACE}b}/api/v4/projects${BT}; const z = '*/';`
      )
    ).toHaveLength(1);
  });
});

describe('providerCodeOutsideScmViolations', () => {
  const OUT = 'packages/gateway/src/lib/gitlabThing.ts';
  it('reports provider API tokens outside lib/scm', () => {
    for (const src of [
      'const u = `<<base>>/api/v4/projects/<<id>>`;',
      "fetch('https://api.bitbucket.org/2.0/repositories/a/b');",
      "const u = base + '/2.0/repositories/' + slug;",
      "get('/rest/api/1.0/projects/P/repos');",
      "import { Gitlab } from '@gitbeaker/rest';",
      "import Bitbucket from 'bitbucket';",
      "const { Bitbucket } = require('bitbucket');",
      "get('/projects/1/merge_requests?state=opened');",
      "get('https://dev.azure.com/org/_apis/git/repositories');",
      "get('/api/v1/repos/o/r/pulls');",
      "get('/a/changes/?q=status:open');",
    ]) {
      expect(providerCodeOutsideScmViolations(OUT, tpl(src)), src).toHaveLength(1);
    }
  });

  it('allows the SCM seam, tests, allowlisted files, comments and unrelated code', () => {
    const src = "get('/api/v4/projects/1');";
    expect(providerCodeOutsideScmViolations('packages/worker/src/lib/scm/gitlab.ts', src)).toEqual(
      []
    );
    expect(
      providerCodeOutsideScmViolations('packages/worker/src/lib/scm/gitlab/x.ts', src)
    ).toEqual([]);
    expect(providerCodeOutsideScmViolations('packages/gateway/src/lib/x.test.ts', src)).toEqual([]);
    expect(providerCodeOutsideScmViolations(OUT, src, new Set([OUT]))).toEqual([]);
    expect(providerCodeOutsideScmViolations(OUT, '// GitLab /api/v4/ lives in scm\n')).toEqual([]);
    expect(providerCodeOutsideScmViolations(OUT, "get('/api/v1/repositories');")).toEqual([]);
    expect(providerCodeOutsideScmViolations(OUT, "import x from 'bitbucketish';")).toEqual([]);
  });

  it('reports the line', () => {
    expect(providerCodeOutsideScmViolations(OUT, "a;\nget('/api/v4/x');\n")[0]?.line).toBe(2);
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
