import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDockerBroker } from './dockerBroker.js';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkspaceInfra: () => ({ backend: 'docker', metadataBlockImage: 'alpine:3.20' }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe('broker boot gate', () => {
  it('logs the explicit direct-socket development opt-out', async () => {
    vi.stubEnv('DOCKER_BROKER_REQUIRED', 'false');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await assertDockerBroker();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('protection is disabled'));
  });
  it('rejects direct sockets and misspelled opt-outs', async () => {
    vi.stubEnv('DOCKER_HOST', 'unix:///var/run/docker.sock');
    vi.stubEnv('DOCKER_BROKER_REQUIRED', 'true');
    await expect(assertDockerBroker()).rejects.toThrow('broker required');
    vi.stubEnv('DOCKER_BROKER_REQUIRED', 'False');
    await expect(assertDockerBroker()).rejects.toThrow('true or false');
  });
  it.each([
    { signed: true, status: 403 },
    { signed: false, status: 403 },
    { signed: true, status: 201 },
  ])(
    'requires a broker-signed privileged-create refusal ($signed/$status)',
    async ({ signed, status }) => {
      vi.stubEnv('DOCKER_BROKER_REQUIRED', 'true');
      let body = '';
      const server = http.createServer((req, res) => {
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          res.writeHead(status, signed ? { 'x-asw-docker-broker': 'deny' } : {});
          res.end('{"message":"ASW_DOCKER_BROKER_DENIED: privileged"}');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      vi.stubEnv('DOCKER_HOST', `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`);
      try {
        if (signed && status === 403) {
          await assertDockerBroker();
        } else {
          await expect(assertDockerBroker()).rejects.toThrow('not refused');
        }
        expect(JSON.parse(body)).toMatchObject({
          HostConfig: { CapDrop: ['ALL'], Privileged: true },
          Image: 'alpine:3.20',
          Labels: { 'auto-swe.profile': 'probe' },
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
});
