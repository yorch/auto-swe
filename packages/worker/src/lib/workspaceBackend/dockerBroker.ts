import http from 'node:http';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';

export async function assertDockerBroker(): Promise<void> {
  if (resolveWorkspaceInfra().backend !== 'docker') {
    return;
  }
  if (process.env.DOCKER_BROKER_REQUIRED === 'false') {
    console.warn(
      '[workspace] DOCKER_BROKER_REQUIRED=false: Docker API policy protection is disabled'
    );
    return;
  }
  if (
    process.env.DOCKER_BROKER_REQUIRED !== undefined &&
    process.env.DOCKER_BROKER_REQUIRED !== 'true'
  ) {
    throw new Error('DOCKER_BROKER_REQUIRED must be true or false');
  }
  const address = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock';
  const host = address.startsWith('tcp://') ? address.replace(/^tcp:/, 'http:') : address;
  if (!host.startsWith('http://')) {
    throw new Error(
      'Docker policy broker required: DOCKER_HOST must address its HTTP endpoint; direct-socket development requires DOCKER_BROKER_REQUIRED=false'
    );
  }
  const body = JSON.stringify({
    HostConfig: {
      CapDrop: ['ALL'],
      Memory: 128 * 1024 ** 2,
      NanoCpus: 1e9,
      NetworkMode: 'default',
      PidsLimit: 64,
      Privileged: true,
      SecurityOpt: ['no-new-privileges'],
    },
    Image: resolveWorkspaceInfra().metadataBlockImage,
    Labels: { 'auto-swe.profile': 'probe' },
  });
  await new Promise<void>((resolve, reject) => {
    const request = http.request(
      new URL('/containers/create', host),
      {
        headers: { 'content-length': Buffer.byteLength(body), 'content-type': 'application/json' },
        method: 'POST',
      },
      (response) => {
        let data = '';
        response.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          if (data.length > 4096) {
            request.destroy(new Error('Unexpected broker probe response'));
          }
        });
        response.on('end', () => {
          if (
            response.statusCode === 403 &&
            response.headers['x-asw-docker-broker'] === 'deny' &&
            data.includes('ASW_DOCKER_BROKER_DENIED')
          ) {
            resolve();
          } else {
            reject(
              new Error(
                'Docker policy broker required: privileged-create probe was not refused by the broker'
              )
            );
          }
        });
        response.on('error', reject);
      }
    );
    request.setTimeout(10_000, () =>
      request.destroy(new Error('Docker policy broker probe timed out'))
    );
    request.on('error', reject);
    request.end(body);
  });
}
