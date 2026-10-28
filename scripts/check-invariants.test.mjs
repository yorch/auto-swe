import { describe, expect, it } from 'vitest';
import { envCredentialViolations, optInSuiteViolations } from './check-invariants.mjs';

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
