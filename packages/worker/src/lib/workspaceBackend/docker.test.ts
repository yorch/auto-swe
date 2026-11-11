import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DOCKER_HOST_ALIAS } from '@auto-swe/shared/lib/systemConfig';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertBaselineEgress,
  assertEgressLocked,
  baselineRules,
  buildBaselineEgressScript,
  buildEgressHelperCommand,
  buildEgressLockScript,
  buildServiceContainerArgs,
  dockerWorkspaceBackend,
  ephemeralArgs,
  resolveEgressTargets,
} from './docker.js';

function baselineReport(
  allow: Parameters<typeof baselineRules>[0] = [],
  cidrs: string[] = [],
  privateBlock = true,
  metadataBlock = true
): string {
  const rules = baselineRules(allow, cidrs, privateBlock, metadataBlock);
  return [
    'v4:',
    '-P OUTPUT ACCEPT',
    '-A OUTPUT -j ASW_BASELINE',
    ...rules.v4.map((r) => `-A ASW_BASELINE ${r}`),
    'v6:',
    '-P OUTPUT ACCEPT',
    '-A OUTPUT -j ASW_BASELINE',
    ...rules.v6.map((r) => `-A ASW_BASELINE ${r}`),
    'v6disabled=0',
  ].join('\n');
}

describe('baseline egress', () => {
  it.each([0, 1])('restores filtered DNS when package installation exits %i', async (exitCode) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-dns-'));
    const resolver = path.join(dir, 'resolv.conf');
    const original = 'nameserver 127.0.0.2\nsearch test\n';
    try {
      await fs.writeFile(resolver, original);
      const script = buildBaselineEgressScript([], [], true, true, ['1.1.1.1'])
        .split('\nv6=1')[0]
        .replaceAll('/etc/resolv.conf', '"$TEST_RESOLV"');
      const run = () =>
        execFileSync(
          'sh',
          [
            '-c',
            `
command() { return 1; }
apk() {
  [ "$(cat "$TEST_RESOLV")" = 'nameserver 1.1.1.1' ] || exit 2
  return ${exitCode}
}
${script}
`,
          ],
          { env: { ...process.env, TEST_RESOLV: resolver }, stdio: 'pipe' }
        );
      if (exitCode === 0) {
        expect(run).not.toThrow();
      } else {
        expect(run).toThrow('helper image has no iptables');
      }
      expect(await fs.readFile(resolver, 'utf8')).toBe(original);
    } finally {
      await fs.rm(dir, { force: true, recursive: true });
    }
  });

  it('bootstraps filtered DNS only for helper packages and restores it before installing rules', () => {
    const script = buildBaselineEgressScript([], [], true, true, [
      '1.1.1.1',
      '2606:4700:4700::1111',
    ]);
    expect(script).toContain('asw_dns=$(cat /etc/resolv.conf)');
    expect(script).toContain(`trap 'printf "%s\\n" "$asw_dns" > /etc/resolv.conf' EXIT`);
    expect(script).toContain('nameserver 1.1.1.1\nnameserver 2606:4700:4700::1111');
    expect(script.indexOf('asw_dns=')).toBeLessThan(script.indexOf('apk add'));
    expect(script.indexOf('apk add')).toBeLessThan(script.indexOf('trap - EXIT'));
    expect(script.indexOf('trap - EXIT')).toBeLessThan(script.indexOf('iptables -N ASW_BASELINE'));
    expect(buildBaselineEgressScript([], [])).not.toContain('asw_dns=');
    expect(() => buildBaselineEgressScript([], [], true, true, ['bad; server'])).toThrow(
      'bootstrap DNS server must be an IP'
    );
  });

  it('puts loopback and replies first, metadata before allow, and private REJECTs last', () => {
    const script = buildBaselineEgressScript([{ ip: '10.1.2.3', port: 443 }], ['10.0.0.0/8']);
    expect(script.indexOf('-o lo')).toBeLessThan(script.indexOf('--ctstate'));
    expect(script.indexOf('169.254.169.254')).toBeLessThan(script.indexOf('10.1.2.3'));
    expect(script.indexOf('10.1.2.3')).toBeLessThan(script.indexOf('10.0.0.0/8 -j REJECT'));
    expect(script).toContain('ip6tables unusable and IPv6 enabled');
    expect(script).toContain('ip6tables -S ASW_BASELINE');
    expect(script).not.toContain('-P OUTPUT DROP');
    const metadata = [
      '169.254.169.254',
      '169.254.170.2',
      '100.100.100.200',
      '192.0.0.192',
      '168.63.129.16',
      'fd00:ec2::254',
    ];
    const rules = baselineRules(
      metadata.map((ip) => ({ ip })),
      ['0.0.0.0/0', '::/0']
    );
    for (const ip of metadata) {
      const family = ip.includes(':') ? rules.v6 : rules.v4;
      expect(family.indexOf(`-d ${ip} -j REJECT`)).toBeLessThan(
        family.indexOf(`-d ${ip} -j ACCEPT`)
      );
      expect(family.indexOf(`-d ${ip} -j REJECT`)).toBeGreaterThan(0);
      expect(() =>
        assertBaselineEgress(
          baselineReport().replace(`-d ${ip} -j REJECT`, `-d ${ip} -j ACCEPT`),
          [],
          []
        )
      ).toThrow();
    }
  });

  it('verifies ordered kernel rules and tolerates IPv6 unavailable only when disabled', () => {
    const report = baselineReport();
    expect(() => assertBaselineEgress(report, [], [])).not.toThrow();
    expect(() => assertBaselineEgress('', [], [])).toThrow();
    const canonical = baselineReport([], ['10.12.34.56/8', 'fd00:12::123/64'])
      .replace('10.12.34.56/8', '10.0.0.0/8')
      .replace('fd00:12::123/64', 'fd00:12::/64')
      .replace('::ffff:0:0/96', '::ffff:0.0.0.0/96')
      .replace('-d 169.254.169.254 ', '-d 169.254.169.254/32 ');
    expect(() =>
      assertBaselineEgress(canonical, [], ['10.12.34.56/8', 'fd00:12::123/64'])
    ).not.toThrow();
    expect(() => buildBaselineEgressScript([], ['10.0.0.0/8;true'])).toThrow('invalid CIDR');
    expect(() =>
      assertBaselineEgress(
        report.replace('-d 10.0.0.0/8 -j REJECT', '-d 10.0.0.0/8 -j ACCEPT'),
        [],
        []
      )
    ).toThrow();
    expect(() =>
      assertBaselineEgress(
        report.replace('-A OUTPUT -j ASW_BASELINE', '-A OUTPUT -j ACCEPT'),
        [],
        []
      )
    ).toThrow();
    const v4 = report.split('v6:')[0];
    expect(() =>
      assertBaselineEgress(`${v4}v6:\nv6-unavailable\nv6disabled=1\n`, [], [])
    ).not.toThrow();
    expect(() =>
      assertBaselineEgress(`${v4}v6:\nv6-unavailable\nv6disabled=0\n`, [], [])
    ).toThrow();
    expect(() =>
      assertBaselineEgress(baselineReport([], [], false, true), [], [], false, true)
    ).not.toThrow();
  });

  it('strict locking detaches the baseline and installs DROP without an established OUTPUT bypass', () => {
    const script = buildEgressLockScript([]);
    expect(script).toContain('iptables -F OUTPUT');
    expect(script).toContain('ip6tables -F OUTPUT');
    expect(script).toContain('iptables -P OUTPUT DROP');
    expect(script).not.toContain('ASW_BASELINE');
    expect(script).not.toContain('-A OUTPUT -m conntrack --ctstate');
  });

  it('executes baseline then strict scripts against the same simulated kernel tables', () => {
    const tables = `
rules4_OUTPUT=''; rules4_INPUT=''; rules4_ASW_BASELINE=''
rules6_OUTPUT=''; rules6_INPUT=''; rules6_ASW_BASELINE=''
policy4_OUTPUT=ACCEPT; policy4_INPUT=ACCEPT
policy6_OUTPUT=ACCEPT; policy6_INPUT=ACCEPT
fake_table() {
  family=$1; action=$2; chain=$3; shift 3
  key="rules"$family"_$chain"
  eval "previous=\\"\\$$key\\""
  case "$action" in
    -N|-F) eval "$key=''" ;;
    -P) eval "policy"$family"_$chain=$1" ;;
    -A) eval "$key=\\"$previous
-A $chain $*\\"" ;;
    -I) shift; eval "$key=\\"-A $chain $*
$previous\\"" ;;
    -S)
      case "$chain" in
        INPUT|OUTPUT) policykey="policy"$family"_$chain"; eval "policy=\\"\\$$policykey\\""; echo "-P $chain $policy" ;;
        *) echo "-N $chain" ;;
      esac
      printf '%s\\n' "$previous" ;;
    *) return 1 ;;
  esac
}
iptables() { fake_table 4 "$@"; }
ip6tables() { fake_table 6 "$@"; }
conntrack() { :; }
`;
    const output = execFileSync(
      'sh',
      [
        '-c',
        `${tables}\n${buildBaselineEgressScript([], [])}\necho strict:\n${buildEgressLockScript([])}`,
      ],
      { encoding: 'utf8' }
    );
    const [baseline = '', strict = ''] = output.split('strict:\n');
    expect(() => assertBaselineEgress(baseline, [], [])).not.toThrow();
    expect(() => assertEgressLocked(strict)).not.toThrow();
    expect(strict).not.toContain('-A OUTPUT -j ASW_BASELINE');
    expect(strict).not.toContain('-A OUTPUT -m conntrack --ctstate');
  });
});

describe('buildServiceContainerArgs', () => {
  it('hardens service sidecars in the workspace network namespace', () => {
    const args = buildServiceContainerArgs('workspace-abc123', {
      env: { POSTGRES_PASSWORD: 'kept-off-argv' },
      image: 'mirror.gcr.io/library/postgres:18',
      name: 'postgres',
      port: 5432,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        '--name',
        'workspace-abc123-svc-postgres',
        '--network',
        'container:workspace-abc123',
        '--memory=512m',
        '--cpus=1',
        '--pids-limit=128',
        '--security-opt=no-new-privileges',
        '--cap-drop=ALL',
        '--cap-add=CHOWN',
        '--cap-add=SETUID',
        '--cap-add=SETGID',
        '--cap-add=FOWNER',
        '--cap-add=DAC_OVERRIDE',
        '-e',
        'POSTGRES_PASSWORD',
      ])
    );
    expect(args).not.toContain('kept-off-argv');
  });

  it('runs a configured non-root service without adding capabilities', () => {
    const args = buildServiceContainerArgs('workspace-abc123', {
      image: 'postgres:18',
      name: 'postgres',
      runAsGroup: 999,
      runAsUser: 999,
    });

    expect(args).toEqual(expect.arrayContaining(['--user', '999:999', '--cap-drop=ALL']));
    expect(args.some((arg) => arg.startsWith('--cap-add='))).toBe(false);
  });

  it('defaults a non-root service group to its user id', () => {
    const args = buildServiceContainerArgs('workspace-abc123', {
      image: 'postgres:18',
      name: 'postgres',
      runAsUser: 999,
    });

    expect(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2)).toEqual([
      '--user',
      '999:999',
    ]);
  });

  it('carries the orphan-sweep labels so a leaked service container is reaped', () => {
    const image = 'mirror.gcr.io/library/postgres:18';
    const args = buildServiceContainerArgs('workspace-abc123', {
      image,
      name: 'postgres',
      port: 5432,
    });
    const separator = args.indexOf('--');
    const createdAt = args.find((a) => a.startsWith('auto-swe.created-at='));
    expect(createdAt).toMatch(/^auto-swe\.created-at=\d+$/);
    for (const label of ['auto-swe.workspace=true', createdAt ?? '']) {
      const at = args.indexOf(label);
      expect(args[at - 1]).toBe('--label');
      expect(at).toBeLessThan(separator);
    }
    expect(separator).toBeLessThan(args.indexOf(image));
  });
});

describe('ephemeralArgs', () => {
  it('runs with no network unless the spec asks for egress', () => {
    expect(ephemeralArgs({ image: 'img' }, false)).toContain('--network=none');
    expect(ephemeralArgs({ image: 'img', network: 'none' }, false)).toContain('--network=none');
    expect(ephemeralArgs({ image: 'img', network: 'egress' }, false)).toContain('--network=bridge');
  });

  it('maps reachWorker to the host-gateway alias, after the resolved hosts', () => {
    const args = ephemeralArgs(
      { addHosts: ['example.com:203.0.113.7'], image: 'img', reachWorker: true },
      false
    );
    const hosts = args.filter((a) => a.startsWith('--add-host='));
    expect(hosts).toEqual([
      '--add-host=example.com:203.0.113.7',
      `--add-host=${DOCKER_HOST_ALIAS}:host-gateway`,
    ]);
  });

  it('adds no worker alias when the container does not need the worker', () => {
    const args = ephemeralArgs({ image: 'img' }, false);
    expect(args.some((a) => a.startsWith('--add-host='))).toBe(false);
  });

  it('refuses a credential-named plain env pair, and passes the registry switches', () => {
    expect(() => ephemeralArgs({ env: ['YARN_NPM_AUTH_TOKEN=x'], image: 'img' }, false)).toThrow(
      /YARN_NPM_AUTH_TOKEN/
    );
    const args = ephemeralArgs(
      { env: ['YARN_NPM_ALWAYS_AUTH=true', 'HOME=/h'], image: 'img' },
      false
    );
    expect(args).toEqual(expect.arrayContaining(['YARN_NPM_ALWAYS_AUTH=true', 'HOME=/h']));
  });
});

describe('canReachWorkerProxy', () => {
  it('accepts only a proxy advertised at the Docker host alias', () => {
    const backend = dockerWorkspaceBackend();
    expect(backend.canReachWorkerProxy(`http://${DOCKER_HOST_ALIAS}:9000`)).toBe(true);
    expect(backend.canReachWorkerProxy('http://worker.internal:9000')).toBe(false);
  });
});

describe('secretEnv', () => {
  // A stand-in `docker` first on PATH: records its argv and the value of the
  // secret variable it was handed in its environment.
  const FAKE = `#!/usr/bin/env node
require('node:fs').appendFileSync(
  process.env.FAKE_LOG,
  JSON.stringify({ args: process.argv.slice(2), secret: process.env.ASW_GIT_AUTH ?? null }) + '\\n'
);
`;
  const HEADER = 'AUTHORIZATION: basic c2VjcmV0LXRva2Vu';
  let dir: string;
  let oldPath: string | undefined;
  const calls = async (): Promise<{ args: string[]; secret: string | null }[]> =>
    (await fs.readFile(path.join(dir, 'log.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-secret-'));
    await fs.writeFile(path.join(dir, 'docker'), FAKE, { mode: 0o755 });
    process.env.FAKE_LOG = path.join(dir, 'log.jsonl');
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    delete process.env.ASW_GIT_AUTH;
  });
  afterEach(async () => {
    process.env.PATH = oldPath;
    delete process.env.FAKE_LOG;
    await fs.rm(dir, { force: true, recursive: true });
  });

  const backend = dockerWorkspaceBackend();

  it('exec names the variable and hands the value over in the client environment', async () => {
    await backend.exec(backend.attach('workspace-t1'), ['sh', '-c', 'true'], {
      heartbeatLabel: 't',
      secretEnv: { ASW_GIT_AUTH: HEADER },
    });
    const [call] = await calls();
    expect(call?.args).toEqual(expect.arrayContaining(['-e', 'ASW_GIT_AUTH']));
    expect(JSON.stringify(call?.args)).not.toContain('c2VjcmV0LXRva2Vu');
    expect(call?.secret).toBe(HEADER);
    expect(process.env.ASW_GIT_AUTH).toBeUndefined();
  });

  it('exec with stdin does the same', async () => {
    await backend.exec(backend.attach('workspace-t1'), ['cat'], {
      heartbeatLabel: 't',
      secretEnv: { ASW_GIT_AUTH: HEADER },
      stdin: 'payload',
    });
    const [call] = await calls();
    expect(call?.args).toEqual(expect.arrayContaining(['-i', '-e', 'ASW_GIT_AUTH']));
    expect(JSON.stringify(call?.args)).not.toContain('c2VjcmV0LXRva2Vu');
    expect(call?.secret).toBe(HEADER);
  });

  it('execShell does the same through the shell string', async () => {
    await backend.execShell(backend.attach('workspace-t1'), ['sh', '-c', 'true'], {
      heartbeatLabel: 't',
      secretEnv: { ASW_GIT_AUTH: HEADER },
    });
    const [call] = await calls();
    expect(call?.args).toEqual(expect.arrayContaining(['-e', 'ASW_GIT_AUTH']));
    expect(JSON.stringify(call?.args)).not.toContain('c2VjcmV0LXRva2Vu');
    expect(call?.secret).toBe(HEADER);
  });

  it('runHelper does the same', async () => {
    await backend.runHelper(
      {
        argv: ['-c', 'true'],
        entrypoint: 'sh',
        image: 'helper:1',
        secretEnv: { ASW_GIT_AUTH: HEADER },
      },
      { heartbeatLabel: 't' }
    );
    const [call] = await calls();
    expect(call?.args).toEqual(expect.arrayContaining(['-e', 'ASW_GIT_AUTH']));
    expect(JSON.stringify(call?.args)).not.toContain('c2VjcmV0LXRva2Vu');
    expect(call?.secret).toBe(HEADER);
  });

  it('refuses a credential-named plain env pair, before docker runs', async () => {
    const h = backend.attach('workspace-t1');
    const pair = 'DEPLOY_TOKEN=value-that-must-not-leak';
    const opts = { env: [pair], heartbeatLabel: 't' };
    await expect(backend.exec(h, ['true'], opts)).rejects.toThrow(/DEPLOY_TOKEN.*secretEnv/);
    await expect(backend.execShell(h, ['true'], opts)).rejects.toThrow(/DEPLOY_TOKEN/);
    const spawnIt = () =>
      backend.spawn(h, ['true'], { env: [pair], stdio: ['ignore', 'pipe', 'pipe'] });
    expect(spawnIt).toThrow(/DEPLOY_TOKEN/);
    await expect(
      backend.runHelper({ env: [pair], image: 'helper:1' }, { heartbeatLabel: 't' })
    ).rejects.toThrow(/DEPLOY_TOKEN/);
    await expect(fs.access(path.join(dir, 'log.jsonl'))).rejects.toThrow();
  });

  it('accepts a credential-named variable passed as secretEnv', async () => {
    await backend.exec(backend.attach('workspace-t1'), ['true'], {
      env: ['GIT_AUTHOR_NAME=Ada'],
      heartbeatLabel: 't',
      secretEnv: { ASW_GIT_AUTH: HEADER },
    });
    expect(await calls()).toHaveLength(1);
  });

  it('refuses a secret name that is not a plain identifier, before docker runs', async () => {
    const h = backend.attach('workspace-t1');
    const opts = (name: string) => ({ heartbeatLabel: 't', secretEnv: { [name]: 'v' } });
    for (const name of ['A; id', 'A=b', '1A', '']) {
      await expect(backend.execShell(h, ['sh', '-c', 'true'], opts(name))).rejects.toThrow(
        /invalid secret environment name/
      );
      await expect(backend.exec(h, ['true'], opts(name))).rejects.toThrow(
        /invalid secret environment name/
      );
    }
    expect(() =>
      backend.spawn(h, ['true'], { secretEnv: { 'A=b': 'v' }, stdio: ['ignore', 'pipe', 'pipe'] })
    ).toThrow(/invalid secret environment name/);
    await expect(
      backend.runHelper({ image: 'helper:1', secretEnv: { 'A=b': 'v' } }, { heartbeatLabel: 't' })
    ).rejects.toThrow(/invalid secret environment name/);
    await expect(fs.access(path.join(dir, 'log.jsonl'))).rejects.toThrow();
  });
});

describe('ephemeral containers with secretEnv', () => {
  // A stand-in `docker`: records argv and the token variable it was handed.
  const FAKE = `#!/usr/bin/env node
require('node:fs').appendFileSync(
  process.env.FAKE_LOG,
  JSON.stringify({
    args: process.argv.slice(2),
    token: process.env.YARN_NPM_AUTH_TOKEN ?? null,
  }) + '\\n'
);
`;
  const TOKEN = 'proxy-tok-s3cret';
  let dir: string;
  let oldPath: string | undefined;
  let oldToken: string | undefined;
  const calls = async (): Promise<{ args: string[]; token: string | null }[]> =>
    (await fs.readFile(path.join(dir, 'log.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const spec = {
    env: ['PLAIN=1'],
    image: 'img:1',
    name: 'shellstep-t1',
    secretEnv: { YARN_NPM_AUTH_TOKEN: TOKEN },
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-ephemeral-'));
    await fs.writeFile(path.join(dir, 'docker'), FAKE, { mode: 0o755 });
    process.env.FAKE_LOG = path.join(dir, 'log.jsonl');
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    oldToken = process.env.YARN_NPM_AUTH_TOKEN;
    delete process.env.YARN_NPM_AUTH_TOKEN;
  });
  afterEach(async () => {
    process.env.PATH = oldPath;
    if (oldToken === undefined) {
      delete process.env.YARN_NPM_AUTH_TOKEN;
    } else {
      process.env.YARN_NPM_AUTH_TOKEN = oldToken;
    }
    delete process.env.FAKE_LOG;
    await fs.rm(dir, { force: true, recursive: true });
  });

  it('ephemeralArgs names a secret without its value', () => {
    for (const detached of [false, true]) {
      const args = ephemeralArgs(spec, detached);
      expect(args).toEqual(expect.arrayContaining(['-e', 'YARN_NPM_AUTH_TOKEN', 'PLAIN=1']));
      expect(JSON.stringify(args)).not.toContain(TOKEN);
      // Before the `--` that ends the options, like every other flag.
      expect(args.indexOf('YARN_NPM_AUTH_TOKEN')).toBeLessThan(args.indexOf('--'));
    }
  });

  it('ephemeralArgs refuses a secret name that is not a plain identifier', () => {
    expect(() => ephemeralArgs({ image: 'img:1', secretEnv: { 'A=b': 'v' } }, false)).toThrow(
      /invalid secret environment name/
    );
  });

  it('runEphemeral hands the value over in the client environment only', async () => {
    await dockerWorkspaceBackend().runEphemeral(spec, { heartbeatLabel: 't' });
    const [run] = await calls();
    expect(run?.args).toEqual(expect.arrayContaining(['-e', 'YARN_NPM_AUTH_TOKEN']));
    expect(JSON.stringify(run?.args)).not.toContain(TOKEN);
    expect(run?.token).toBe(TOKEN);
    expect(process.env.YARN_NPM_AUTH_TOKEN).toBeUndefined();
  });

  it('startDetached does the same', async () => {
    await dockerWorkspaceBackend().startDetached(spec, { heartbeatLabel: 't' });
    const [run] = await calls();
    expect(run?.args).toEqual(expect.arrayContaining(['-d', '-e', 'YARN_NPM_AUTH_TOKEN']));
    expect(JSON.stringify(run?.args)).not.toContain(TOKEN);
    expect(run?.token).toBe(TOKEN);
  });
});

describe('create with secretEnv', () => {
  // A stand-in `docker`: records argv and the token variable it was handed, and
  // answers the keeper probe so `create` completes.
  const FAKE = `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(
  process.env.FAKE_LOG,
  JSON.stringify({ args, token: process.env.YARN_NPM_AUTH_TOKEN ?? null }) + '\\n'
);
if (args[0] === 'exec') process.stdout.write('42\\n');
if (args[0] === 'run' && args.includes('--rm')) process.stdout.write(process.env.FAKE_BASELINE ?? '');
`;
  const TOKEN = 'proxy-tok-s3cret';
  let dir: string;
  let oldPath: string | undefined;
  let oldToken: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-create-'));
    await fs.writeFile(path.join(dir, 'docker'), FAKE, { mode: 0o755 });
    process.env.FAKE_LOG = path.join(dir, 'log.jsonl');
    process.env.FAKE_BASELINE = baselineReport();
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    oldToken = process.env.YARN_NPM_AUTH_TOKEN;
    delete process.env.YARN_NPM_AUTH_TOKEN;
  });
  afterEach(async () => {
    process.env.PATH = oldPath;
    if (oldToken === undefined) {
      delete process.env.YARN_NPM_AUTH_TOKEN;
    } else {
      process.env.YARN_NPM_AUTH_TOKEN = oldToken;
    }
    delete process.env.FAKE_LOG;
    delete process.env.FAKE_BASELINE;
    await fs.rm(dir, { force: true, recursive: true });
  });

  it('names the variable on docker run and hands the value over in the environment', async () => {
    await dockerWorkspaceBackend().create({
      cpus: 1,
      dns: [],
      env: ['PLAIN=1'],
      image: 'img:1',
      memory: '1g',
      name: 'workspace-t1',
      pidsLimit: 10,
      reachWorker: false,
      secretEnv: { YARN_NPM_AUTH_TOKEN: TOKEN },
    });
    const lines = (await fs.readFile(path.join(dir, 'log.jsonl'), 'utf8')).split('\n');
    const calls: { args: string[]; token: string | null }[] = lines
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const run = calls.find((c) => c.args[0] === 'run');
    expect(run?.args).toEqual(expect.arrayContaining(['-e', 'YARN_NPM_AUTH_TOKEN', 'PLAIN=1']));
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(TOKEN);
    expect(run?.token).toBe(TOKEN);
  });
});

describe('egress lock', () => {
  const rules = [{ ip: '203.0.113.7', port: 443 }, { ip: '198.51.100.9' }, { ip: '2001:db8::1' }];

  it('builds a default-deny script: resolver refused before lo, no OUTPUT conntrack, DROP last', () => {
    const script = buildEgressLockScript(rules);
    expect(script).toContain("allow_ip '203.0.113.7' '443'");
    expect(script).toContain("allow_ip '198.51.100.9' ''");
    expect(script).toContain("allow_ip '2001:db8::1' ''");
    const lo = script.indexOf('iptables -A OUTPUT -o lo -j ACCEPT');
    expect(lo).toBeGreaterThan(-1);
    for (const rule of [
      'iptables -A OUTPUT -d 127.0.0.11 -p tcp -j REJECT',
      'iptables -A OUTPUT -d 127.0.0.11 -p udp -j REJECT',
      'iptables -A OUTPUT -m conntrack --ctorigdst 127.0.0.11 -j REJECT',
    ]) {
      expect(script.indexOf(rule)).toBeGreaterThan(-1);
      expect(script.indexOf(rule)).toBeLessThan(lo);
    }
    // OUTPUT accepts no conntrack state; INPUT accepts loopback and replies only.
    expect(script).not.toMatch(/-A OUTPUT[^\n]*ESTABLISHED/);
    expect(script).toContain('iptables -A INPUT -i lo -j ACCEPT');
    expect(script).toContain(
      'iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT'
    );
    expect(script).toContain('iptables -P OUTPUT DROP');
    expect(script).toContain('iptables -P INPUT DROP');
    expect(script).toContain('ip6tables -P OUTPUT DROP');
    expect(script).toContain('ip6tables -P INPUT DROP');
    expect(script).toContain('conntrack -F');
    // No DNS is opened, no name resolution happens in the helper, and the policy comes last.
    expect(script).not.toMatch(/dport 53|--dport "53"/);
    expect(script).not.toContain('getent');
    expect(script).not.toContain('allow_host');
    expect(script.lastIndexOf('allow_ip ')).toBeLessThan(script.indexOf('iptables -P OUTPUT DROP'));
  });

  it('skips v6 entries without aborting when ip6tables is unusable and IPv6 is disabled', () => {
    const script = buildEgressLockScript(rules);
    expect(script).toContain('skipping $1 (IPv6 disabled)');
    expect(script).toContain('ip6tables unusable and IPv6 enabled" >&2; exit 1');
  });

  it('refuses a rule that is not a plain, allowed IP address or a 1-65535 port', () => {
    for (const ip of [
      'example.com',
      'a;rm -rf /',
      '',
      '127.0.0.1',
      '169.254.169.254',
      '::1',
      '0.0.0.0',
    ]) {
      expect(() => buildEgressLockScript([{ ip }])).toThrow(/not an IP|refused/);
    }
    for (const port of [0, 65536, -1, 1.5, Number.NaN]) {
      expect(() => buildEgressLockScript([{ ip: '203.0.113.7', port }])).toThrow(/invalid port/);
    }
  });

  it('refuses hosts and ports that are not plain hostnames, IP literals or 1-65535', async () => {
    const resolve = async () => ['203.0.113.7'];
    for (const host of ['a;rm -rf /', 'a b', '$(id)', '', '-x.com', 'a..b', "x'y", 'a/b']) {
      await expect(resolveEgressTargets([{ host }], resolve)).rejects.toThrow(/invalid host/);
    }
    for (const port of [0, 65536, -1, 1.5, Number.NaN]) {
      await expect(resolveEgressTargets([{ host: 'example.com', port }], resolve)).rejects.toThrow(
        /invalid port/
      );
    }
  });

  it('resolves each name once, pins it once, and honours a trusted alias without a line', async () => {
    const resolve = vi.fn(async () => ['203.0.113.7', '2001:db8::1']);
    const out = await resolveEgressTargets(
      [
        { host: 'git.example.com', port: 443 },
        { host: 'Git.Example.com', port: 22 },
        { host: 'host.docker.internal' },
        { host: '198.51.100.9', port: 22 },
      ],
      resolve,
      new Map([['host.docker.internal', ['172.17.0.1']]])
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('git.example.com');
    expect(out.rules).toEqual([
      { ip: '203.0.113.7', port: 443 },
      { ip: '2001:db8::1', port: 443 },
      { ip: '203.0.113.7', port: 22 },
      { ip: '2001:db8::1', port: 22 },
      { ip: '172.17.0.1' },
      { ip: '198.51.100.9', port: 22 },
    ]);
    expect(out.hosts).toEqual([
      ['203.0.113.7', 'git.example.com'],
      ['2001:db8::1', 'git.example.com'],
    ]);
  });

  it('refuses forbidden answers, forbidden literals and names with no address', async () => {
    await expect(
      resolveEgressTargets([{ host: 'evil.example.com' }], async () => ['169.254.169.254'])
    ).rejects.toThrow(/refused address/);
    await expect(
      resolveEgressTargets([{ host: 'evil.example.com' }], async () => ['203.0.113.7', '127.0.0.1'])
    ).rejects.toThrow(/refused address/);
    await expect(resolveEgressTargets([{ host: '127.0.0.1' }], async () => [])).rejects.toThrow(
      /refused address/
    );
    await expect(
      resolveEgressTargets([{ host: 'nx.example.com' }], async () => [])
    ).rejects.toThrow(/no address/);
  });
});

describe('egress script and helper', () => {
  it('runs the helper in the workspace namespace with NET_ADMIN and a quoted script', () => {
    const cmd = buildEgressHelperCommand('workspace-ab12', 'alpine:3.20', "echo 'x'");
    expect(cmd).toContain('--network container:workspace-ab12');
    expect(cmd).toContain('--cap-add=NET_ADMIN');
    expect(cmd).toContain('auto-swe.workspace=true');
    expect(() => buildEgressHelperCommand('bad name;x', 'alpine:3.20', 'true')).toThrow(
      /invalid workspace name/
    );
  });

  it('accepts only a read-back that shows DROP on INPUT and OUTPUT, and IPv6 DROP or disabled', () => {
    const v4 = 'v4:\n-P OUTPUT DROP\n-A OUTPUT -o lo -j ACCEPT\n-P INPUT DROP\n';
    const drop = `${v4}v6:\n-P OUTPUT DROP\n-P INPUT DROP\nv6disabled=0\n`;
    expect(() => assertEgressLocked(drop)).not.toThrow();
    expect(() => assertEgressLocked(`${v4}v6:\nv6-unavailable\nv6disabled=1\n`)).not.toThrow();
    expect(() =>
      assertEgressLocked(
        'v4:\n-P OUTPUT ACCEPT\n-P INPUT DROP\nv6:\n-P OUTPUT DROP\n-P INPUT DROP\n'
      )
    ).toThrow(/IPv4 OUTPUT/);
    expect(() =>
      assertEgressLocked(
        'v4:\n-P OUTPUT DROP\n-P INPUT ACCEPT\nv6:\n-P OUTPUT DROP\n-P INPUT DROP\n'
      )
    ).toThrow(/IPv4 INPUT/);
    expect(() => assertEgressLocked('v4:\n-P OUTPUT DROP\nv6:\n-P OUTPUT DROP\n')).toThrow(/INPUT/);
    expect(() =>
      assertEgressLocked(`${v4}v6:\n-P OUTPUT DROP\n-P INPUT ACCEPT\nv6disabled=0\n`)
    ).toThrow(/IPv6/);
    expect(() =>
      assertEgressLocked(`${v4}v6:\n-P OUTPUT ACCEPT\n-P INPUT DROP\nv6disabled=0\n`)
    ).toThrow(/IPv6/);
    expect(() => assertEgressLocked(`${v4}v6:\nv6-unavailable\nv6disabled=0\n`)).toThrow(/IPv6/);
    expect(() => assertEgressLocked('')).toThrow();
  });
});
