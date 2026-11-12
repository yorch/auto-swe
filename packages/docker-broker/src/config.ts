import { Denied } from './json.ts';

export const OWNER_PREFIX = 'io.auto-swe.broker.';
export const OWNER_LABEL = `${OWNER_PREFIX}owner`;
export const PROFILE_LABEL = 'auto-swe.profile';
export const TARGET_LABEL = 'auto-swe.target';
export const PROFILES = [
  'workspace',
  'probe',
  'service',
  'iptables',
  'pid-cleanup',
  'hosts-writer',
  'holder',
  'author',
  'git-helper',
] as const;
export type Profile = (typeof PROFILES)[number];
export interface Config {
  upstream: URL;
  stateDir: string;
  images: string[];
  helpers: string[];
  networks: string[];
  runtime: string;
  maxJson: number;
  maxStream: number;
  maxMemory: number;
  maxCpus: number;
  maxPids: number;
}
const list = (input: string) =>
  input
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const positive = (input: string | undefined, fallback: number): number => {
  const result = input === undefined ? fallback : Number(input);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error('Invalid broker limit');
  }
  return result;
};
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const upstream = new URL(env.DOCKER_BROKER_UPSTREAM ?? 'http://docker-socket-proxy:2375');
  if (
    upstream.protocol !== 'http:' ||
    upstream.username ||
    upstream.password ||
    upstream.pathname !== '/'
  ) {
    throw new Error('Broker upstream must be an HTTP origin');
  }
  return {
    helpers: list(env.DOCKER_BROKER_HELPER_IMAGES ?? 'alpine:3.20'),
    images: list(
      env.DOCKER_BROKER_ALLOWED_IMAGES ??
        'docker.io/library/*,docker.io/alpine/git,mirror.gcr.io/library/*,ghcr.io/yorch/auto-swe/executor-*'
    ),
    maxCpus: positive(env.DOCKER_BROKER_MAX_CPUS, 16),
    maxJson: positive(env.DOCKER_BROKER_JSON_LIMIT, 2 * 1024 * 1024),
    maxMemory: positive(env.DOCKER_BROKER_MAX_MEMORY, 16 * 1024 ** 3),
    maxPids: positive(env.DOCKER_BROKER_MAX_PIDS, 4096),
    maxStream: positive(env.DOCKER_BROKER_STREAM_LIMIT, 1024 * 1024 * 1024),
    networks: list(env.DOCKER_BROKER_NETWORKS ?? 'bridge,auto-swe-workspaces'),
    runtime: env.WORKSPACE_RUNTIME ?? '',
    stateDir: env.DOCKER_BROKER_STATE_DIR ?? '/state',
    upstream,
  };
}
export function imageReference(input: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(input) || input.includes('..')) {
    throw new Denied('invalid image');
  }
  const parts = input.split('/');
  if (parts.length === 1 || (!/[.:]/.test(parts[0] ?? '') && parts[0] !== 'localhost')) {
    parts.unshift('docker.io');
  }
  if (parts[0] === 'docker.io' && parts.length === 2) {
    parts.splice(1, 0, 'library');
  }
  return parts.join('/');
}
export function allowedImage(image: string, settings: Config, helper = false): boolean {
  const full = imageReference(image);
  if (settings.helpers.some((value) => imageReference(value) === full)) {
    return true;
  }
  if (helper) {
    return false;
  }
  const repository = full.replace(/@.*$/, '').replace(/:[^/]*$/, '');
  return settings.images.some((pattern) => {
    const regex = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
    return new RegExp(`^${regex}$`).test(repository);
  });
}
