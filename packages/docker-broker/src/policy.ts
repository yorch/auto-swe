import { isIP } from 'node:net';
import {
  allowedImage,
  type Config,
  OWNER_PREFIX,
  PROFILE_LABEL,
  PROFILES,
  type Profile,
  TARGET_LABEL,
} from './config.ts';
import { Denied, keys, type ObjectValue, object } from './json.ts';

export interface OwnedContainer {
  id: string;
  profile: Profile;
  user: string;
  hostsPath: string;
}
export interface Registry {
  container(name: string): OwnedContainer;
  volume(name: string): string;
}
export function check(condition: unknown, reason: string): asserts condition {
  if (!condition) {
    throw new Denied(reason);
  }
}
const empty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === '' ||
  value === false ||
  value === 0 ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' && value !== null && Object.keys(value).length === 0);
const strings = (value: unknown): string[] => {
  if (value === undefined || value === null) {
    return [];
  }
  check(
    Array.isArray(value) && value.every((part) => typeof part === 'string'),
    'expected strings'
  );
  return value as string[];
};
export function labels(value: unknown): Record<string, string> {
  const result = value === undefined || value === null ? {} : object(value);
  check(
    Object.entries(result).every(
      ([key, value]) => !key.startsWith(OWNER_PREFIX) && typeof value === 'string'
    ),
    'reserved or invalid label'
  );
  return result as Record<string, string>;
}
function exactCaps(value: unknown, expected: string[]): boolean {
  return (
    JSON.stringify(
      strings(value)
        .map((cap) => cap.replace(/^CAP_/, ''))
        .sort()
    ) === JSON.stringify([...expected].sort())
  );
}
const defaults = [
  'ContainerIDFile',
  'VolumeDriver',
  'VolumesFrom',
  'Links',
  'GroupAdd',
  'Cgroup',
  'CgroupParent',
  'Devices',
  'DeviceRequests',
  'DeviceCgroupRules',
  'Sysctls',
  'MaskedPaths',
  'ReadonlyPaths',
  'UTSMode',
  'UsernsMode',
  'Isolation',
  'DnsOptions',
  'DnsSearch',
  'OomScoreAdj',
  'OomKillDisable',
  'CpuShares',
  'CpuPeriod',
  'CpuQuota',
  'CpuRealtimePeriod',
  'CpuRealtimeRuntime',
  'CpusetCpus',
  'CpusetMems',
  'MemoryReservation',
  'MemorySwap',
  'Ulimits',
  'CpuCount',
  'CpuPercent',
  'IOMaximumIOps',
  'IOMaximumBandwidth',
  'BlkioWeight',
  'BlkioWeightDevice',
  'BlkioDeviceReadBps',
  'BlkioDeviceWriteBps',
  'BlkioDeviceReadIOps',
  'BlkioDeviceWriteIOps',
  'Annotations',
  'LxcConf',
  'KernelMemory',
];
export async function containerCreate(
  input: unknown,
  config: Config,
  owned: Registry
): Promise<ObjectValue> {
  const body = object(input);
  keys(body, [
    'Hostname',
    'Domainname',
    'User',
    'AttachStdin',
    'AttachStdout',
    'AttachStderr',
    'ExposedPorts',
    'Tty',
    'OpenStdin',
    'StdinOnce',
    'Env',
    'Cmd',
    'Image',
    'Volumes',
    'WorkingDir',
    'Entrypoint',
    'OnBuild',
    'Labels',
    'HostConfig',
    'NetworkingConfig',
    'StopSignal',
    'StopTimeout',
    'Healthcheck',
    'ArgsEscaped',
    'Shell',
    'NetworkDisabled',
  ]);
  const host = object(body.HostConfig);
  check(!host.Privileged, 'privileged containers forbidden');
  const tag = labels(body.Labels);
  const profile = tag[PROFILE_LABEL] as Profile;
  check(PROFILES.includes(profile), 'container profile required');
  check(
    typeof body.Image === 'string' &&
      allowedImage(
        body.Image,
        config,
        ['iptables', 'pid-cleanup', 'hosts-writer', 'holder', 'probe'].includes(profile)
      ),
    'image not allowed'
  );
  strings(body.Cmd);
  strings(body.Entrypoint);
  strings(body.Env);
  for (const key of [
    'AttachStdin',
    'AttachStdout',
    'AttachStderr',
    'Tty',
    'OpenStdin',
    'StdinOnce',
    'ArgsEscaped',
    'NetworkDisabled',
  ]) {
    check(body[key] === undefined || typeof body[key] === 'boolean', 'invalid container boolean');
  }
  for (const key of ['Hostname', 'Domainname', 'WorkingDir', 'User', 'StopSignal']) {
    check(body[key] === undefined || typeof body[key] === 'string', 'invalid container string');
  }
  for (const key of ['Volumes', 'OnBuild', 'Healthcheck', 'Shell', 'NetworkDisabled']) {
    check(empty(body[key]), 'unsupported container configuration');
  }
  check(
    body.StopTimeout === undefined ||
      body.StopTimeout === null ||
      (Number.isSafeInteger(body.StopTimeout) &&
        Number(body.StopTimeout) >= 0 &&
        Number(body.StopTimeout) <= 60),
    'invalid stop timeout'
  );
  keys(host, [
    ...defaults,
    'Privileged',
    'PublishAllPorts',
    'Binds',
    'Mounts',
    'CapAdd',
    'CapDrop',
    'NetworkMode',
    'PidMode',
    'IpcMode',
    'CgroupnsMode',
    'Runtime',
    'PortBindings',
    'Tmpfs',
    'ReadonlyRootfs',
    'SecurityOpt',
    'Memory',
    'NanoCpus',
    'PidsLimit',
    'StorageOpt',
    'Dns',
    'ExtraHosts',
    'AutoRemove',
    'Init',
    'ShmSize',
    'ConsoleSize',
    'RestartPolicy',
    'LogConfig',
    'MemorySwappiness',
  ]);
  for (const key of defaults) {
    // An explicit empty list disables Docker's protected proc paths.
    check(
      key === 'MaskedPaths' || key === 'ReadonlyPaths'
        ? host[key] === undefined || host[key] === null
        : empty(host[key]),
      'unsupported host configuration'
    );
  }
  check(
    host.MemorySwappiness === undefined ||
      host.MemorySwappiness === null ||
      host.MemorySwappiness === -1 ||
      host.MemorySwappiness === 0,
    'memory swappiness forbidden'
  );
  check(
    !host.PublishAllPorts && (host.Privileged === undefined || host.Privileged === false),
    'privileged or automatic ports forbidden'
  );
  check(
    host.Runtime === undefined ||
      host.Runtime === '' ||
      (config.runtime !== '' && host.Runtime === config.runtime),
    'runtime not allowed'
  );
  check(
    host.CgroupnsMode === undefined || host.CgroupnsMode === '' || host.CgroupnsMode === 'private',
    'host cgroup namespace forbidden'
  );
  check(
    host.IpcMode === undefined || host.IpcMode === '' || host.IpcMode === 'private',
    'shared IPC forbidden'
  );
  const security = strings(host.SecurityOpt);
  check(
    security.length === 1 &&
      ['no-new-privileges', 'no-new-privileges:true'].includes(security[0] ?? ''),
    'security options not allowed'
  );
  check(exactCaps(host.CapDrop, ['ALL']), 'all capabilities must be dropped');
  const caps =
    profile === 'iptables'
      ? ['NET_ADMIN']
      : profile === 'pid-cleanup'
        ? ['KILL', 'SYS_PTRACE']
        : [];
  check(
    exactCaps(host.CapAdd, caps) ||
      (profile === 'service' &&
        exactCaps(host.CapAdd, ['CHOWN', 'SETUID', 'SETGID', 'FOWNER', 'DAC_OVERRIDE'])),
    'capabilities not allowed'
  );
  for (const [key, max] of [
    ['Memory', config.maxMemory],
    ['NanoCpus', config.maxCpus * 1e9],
    ['PidsLimit', config.maxPids],
  ] as const) {
    check(
      Number.isSafeInteger(host[key]) && Number(host[key]) > 0 && Number(host[key]) <= max,
      'resource limit missing or too high'
    );
  }
  for (const key of ['AutoRemove', 'Init', 'ReadonlyRootfs']) {
    check(
      host[key] === undefined || host[key] === null || typeof host[key] === 'boolean',
      'invalid host boolean'
    );
  }
  check(
    host.ShmSize === undefined || host.ShmSize === 0 || host.ShmSize === 67108864,
    'shared memory not allowed'
  );
  check(
    host.ConsoleSize === undefined ||
      (Array.isArray(host.ConsoleSize) &&
        host.ConsoleSize.length === 2 &&
        host.ConsoleSize.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 10000)),
    'invalid console size'
  );
  if (host.RestartPolicy !== undefined) {
    const restart = object(host.RestartPolicy);
    keys(restart, ['Name', 'MaximumRetryCount']);
    check(
      ['', 'no', undefined].includes(restart.Name as string | undefined) &&
        empty(restart.MaximumRetryCount),
      'restart policy forbidden'
    );
  }
  if (host.LogConfig !== undefined) {
    const logging = object(host.LogConfig);
    keys(logging, ['Type', 'Config']);
    check(empty(logging.Type) && empty(logging.Config), 'log driver forbidden');
  }
  if (!empty(host.StorageOpt)) {
    const storage = object(host.StorageOpt);
    keys(storage, ['size']);
    check(
      typeof storage.size === 'string' && /^\d+[kKmMgGtT]?$/.test(storage.size),
      'storage option forbidden'
    );
  }
  check(
    strings(host.Dns).every((address) => isIP(address) !== 0),
    'invalid DNS'
  );
  check(
    strings(host.ExtraHosts).every((line) =>
      /^[a-zA-Z0-9.-]+:(?:host-gateway|[a-fA-F0-9:.]+)$/.test(line)
    ),
    'invalid hosts'
  );
  const readonly = ['author', 'holder', 'pid-cleanup', 'hosts-writer'].includes(profile);
  check(!readonly || host.ReadonlyRootfs === true, 'read-only root required');
  const tmpfs = host.Tmpfs === undefined || host.Tmpfs === null ? {} : object(host.Tmpfs);
  keys(tmpfs, ['/tmp']);
  check(
    Object.values(tmpfs).every(
      (value) => value === 'size=64m,mode=1777' || value === 'size=67108864,mode=1777'
    ),
    'tmpfs forbidden'
  );
  check(
    !['author', 'holder'].includes(profile) || tmpfs['/tmp'] !== undefined,
    'author tmpfs required'
  );
  const network = host.NetworkMode ?? 'default';
  check(typeof network === 'string', 'invalid network');
  check(network !== 'host', 'host network forbidden');
  const join = (value: string, profiles: Profile[]) => {
    const target = owned.container(value);
    check(profiles.includes(target.profile), 'wrong namespace target profile');
    return target;
  };
  if (['iptables', 'service', 'author'].includes(profile) && network.startsWith('container:')) {
    const target = join(
      network.slice(10),
      profile === 'author' ? ['holder'] : ['workspace', 'probe', 'holder']
    );
    host.NetworkMode = `container:${target.id}`;
  } else if (profile === 'pid-cleanup' || profile === 'hosts-writer' || profile === 'author') {
    check(network === 'none', 'network must be none');
  } else {
    check(network !== 'host' && !network.startsWith('container:'), 'shared network forbidden');
    check(profile !== 'iptables' && profile !== 'service', 'target namespace required');
    check(network === 'default' || config.networks.includes(network), 'network not allowed');
  }
  if (profile === 'pid-cleanup') {
    check(
      typeof host.PidMode === 'string' && host.PidMode.startsWith('container:'),
      'target PID namespace required'
    );
    host.PidMode = `container:${join(host.PidMode.slice(10), ['workspace', 'probe']).id}`;
  } else {
    check(empty(host.PidMode), 'shared PID namespace forbidden');
  }
  const binds = strings(host.Binds);
  check(empty(host.Mounts), 'caller mounts forbidden');
  if (profile === 'author' || profile === 'git-helper') {
    check(binds.length === 1, 'one workspace volume required');
    const match = /^([^/:]+):\/workspace:(rw|ro)$/.exec(binds[0] ?? '');
    check(match, 'workspace named volume required');
    host.Binds = [`${owned.volume(match[1] ?? '')}:/workspace:${match[2]}`];
  } else {
    check(binds.length === 0, 'bind mounts forbidden');
  }
  if (profile === 'hosts-writer') {
    const target = owned.container(tag[TARGET_LABEL] ?? '');
    check(['workspace', 'probe', 'holder'].includes(target.profile), 'invalid hosts target');
    check(
      target.hostsPath.startsWith('/') &&
        target.hostsPath.endsWith(`/${target.id}/hosts`) &&
        !/[\r\n,]/.test(target.hostsPath),
      'invalid daemon hosts path'
    );
    check(
      body.User === '0:0' &&
        JSON.stringify(body.Cmd) ===
          JSON.stringify([
            '/usr/bin/env',
            '-i',
            'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
            '/bin/sh',
            '-ec',
            'cat > /asw-hosts',
          ]),
      'invalid hosts writer command'
    );
    host.Mounts = [
      { ReadOnly: false, Source: target.hostsPath, Target: '/asw-hosts', Type: 'bind' },
    ];
  }
  const ports =
    body.ExposedPorts === undefined || body.ExposedPorts === null ? {} : object(body.ExposedPorts);
  const bindings =
    host.PortBindings === undefined || host.PortBindings === null ? {} : object(host.PortBindings);
  check(Object.keys(ports).length <= 1 && Object.keys(bindings).length <= 1, 'too many ports');
  for (const [port, entries] of Object.entries(bindings)) {
    check(
      profile === 'holder' &&
        /^(?:[1-9][0-9]{0,4})\/tcp$/.test(port) &&
        Number(port.split('/')[0]) <= 65535 &&
        Object.hasOwn(ports, port),
      'port not allowed'
    );
    check(Array.isArray(entries) && entries.length === 1, 'one loopback binding required');
    const entry = object(entries[0]);
    keys(entry, ['HostIp', 'HostPort']);
    check(
      entry.HostIp === '127.0.0.1' && (entry.HostPort === '' || entry.HostPort === '0'),
      'loopback ephemeral port required'
    );
  }
  check(
    Object.keys(ports).every((port) => Object.hasOwn(bindings, port)),
    'unbound exposed port forbidden'
  );
  if (body.NetworkingConfig !== undefined && body.NetworkingConfig !== null) {
    const networking = object(body.NetworkingConfig);
    keys(networking, ['EndpointsConfig']);
    const endpoints =
      networking.EndpointsConfig === undefined || networking.EndpointsConfig === null
        ? {}
        : object(networking.EndpointsConfig);
    for (const [name, value] of Object.entries(endpoints)) {
      check(
        name === network && !network.startsWith('container:') && network !== 'none',
        'network endpoint forbidden'
      );
      const endpoint = object(value);
      keys(endpoint, [
        'IPAMConfig',
        'Links',
        'Aliases',
        'MacAddress',
        'DriverOpts',
        'NetworkID',
        'EndpointID',
        'Gateway',
        'IPAddress',
        'IPPrefixLen',
        'IPv6Gateway',
        'GlobalIPv6Address',
        'GlobalIPv6PrefixLen',
        'DNSNames',
        'GwPriority',
      ]);
      check(Object.values(endpoint).every(empty), 'custom network endpoint forbidden');
    }
  }
  return body;
}

export function route(
  method: string,
  raw: string
): { path: string; query: URLSearchParams; version: string } {
  check(
    raw.startsWith('/') &&
      !/[%\\#\s]/.test(raw.split('?')[0] ?? '') &&
      !raw.includes('//') &&
      ![...raw].some((character) => character.charCodeAt(0) < 32),
    'noncanonical path'
  );
  const [pathname = '', search = ''] = raw.split('?');
  check(
    raw.split('?').length <= 2 &&
      !pathname.split('/').some((part) => part === '.' || part === '..'),
    'noncanonical path'
  );
  const version = /^\/v[0-9]+\.[0-9]+(?=\/)/.exec(pathname)?.[0] ?? '';
  const path = pathname.slice(version.length);
  const query = new URLSearchParams(search);
  check(new Set(query.keys()).size === [...query.keys()].length, 'duplicate query');
  check(['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(method), 'method forbidden');
  return { path, query, version };
}
export function querySchema(query: URLSearchParams, schema: Record<string, RegExp>): void {
  for (const [key, value] of query) {
    check(schema[key]?.test(value), 'query forbidden');
  }
}
export const bool = /^(?:0|1|true|false)$/;
export function rootUser(user: string): boolean {
  return user === '' || /^(?:0|root)(?::[^:]*)?$/.test(user);
}
