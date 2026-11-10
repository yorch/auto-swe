# Kubernetes with Helm

`deploy/helm/auto-swe` is a Helm chart for the three application services — the gateway, the
worker and the web dashboard — against a PostgreSQL and a Temporal you run elsewhere. Agent
workspaces run as pods in their own namespace, through the worker's Kubernetes workspace backend
([`architecture.md`](./architecture.md#kubernetes-backend)). [`deployment.md`](./deployment.md) stays
the runbook for everything the chart does not cover: the database, Temporal, images, the admin-UI
configuration after first boot, and hardening.

## 1. What the chart deploys

| Resource | Purpose |
|---|---|
| `<release>-gateway` Deployment + Service | Fastify API on `:8080`, two replicas by default. Probes: `GET /health` (startup, readiness, liveness), which answers 200 once Fastify is listening whatever Temporal's state |
| `<release>-web` Deployment + Service | Next.js dashboard on `:3000`, two replicas by default. Probes: `GET /health` |
| `<release>-worker` Deployment (one replica, `Recreate`) + ServiceAccount | The Temporal worker with `WORKSPACE_BACKEND=kubernetes`. An init container waits for the gateway's `/health`, because the worker refuses to boot until the gateway has synced the built-in agents, skills and scanner patterns. Probes: the image's own check, a `/tmp/worker-alive` file the worker touches while its poller runs |
| `<release>-worker-proxy` Service | How workspace pods reach the worker's model proxy (required on this backend) and, when their ports are set, its registry and egress proxies. Its DNS name is what `HARNESS_MODEL_PROXY_URL`, `REGISTRY_PROXY_URL` and `EGRESS_PROXY_URL` carry |
| `<release>-migrate` Job | `prisma migrate deploy`, as a `pre-install` / `pre-upgrade` hook (below) |
| `<release>-config` ConfigMap | Non-secret environment for the gateway and the worker: the public URLs, `TEMPORAL_ADDRESS`, the artifact store, `config.extraEnv` |
| `<release>-secrets` Secret | Only when `secrets.existingSecret` is empty: rendered from `secrets.values` and `secrets.extra` |
| Workspace namespace (`workspaces.manage`) | The namespace (PodSecurity `restricted`), its default-deny NetworkPolicy, a ResourceQuota, and the worker's Role and RoleBinding — `infra/kubernetes/workspace-namespace.yaml` with this release's worker filled in |
| Ingress (`ingress.enabled=true`) | One rule for the host of `urls.api` to the gateway and one for the host of `urls.web` to the dashboard |

Every pod runs as uid 1000 (the images' `node` user) with `runAsNonRoot`, every capability dropped,
no privilege escalation and the `RuntimeDefault` seccomp profile. Only the worker mounts a
ServiceAccount token: it runs `kubectl` against the workspace namespace with it.

## 2. Before installing

- **PostgreSQL** with the `vector` extension, 0.8 or later ([`deployment.md` §3](./deployment.md#3-database-setup)).
- **Temporal**, its frontend reachable from the release namespace ([`deployment.md` §4](./deployment.md#4-temporal-setup)).
- **A CNI that enforces NetworkPolicy** (GKE Dataplane V2; EKS VPC CNI with network policy
  enabled; AKS with Azure NPM, Cilium or Calico). The worker launches a probe pod at start and
  refuses to run if it can reach the cloud metadata endpoint or the cluster API address.
- **Rights to create** a Namespace, and a Role and RoleBinding in it, for the person or pipeline
  running `helm install`. Without them, set `workspaces.manage=false` and apply
  `infra/kubernetes/workspace-namespace.yaml` yourself (bind its Role to the chart's worker
  ServiceAccount, `<release>-worker` unless `worker.serviceAccount.name` says otherwise).
- **A node-pool `podPidsLimit`**: Kubernetes has no per-pod PID cap, so `WORKSPACE_PIDS_LIMIT` is
  not applied to workspace pods.

## 3. Installing

Create the Secret the chart reads (recommended over passing secrets as values):

```bash
kubectl create namespace auto-swe
kubectl -n auto-swe create secret generic auto-swe-env \
  --from-literal=DATABASE_URL='postgresql://auto_swe:…@db.internal:5432/auto_swe?sslmode=require' \
  --from-literal=CONFIG_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 48)" \
  --from-literal=JWT_SECRET="$(openssl rand -base64 48)"
```

Every key in that Secret reaches the gateway and the worker as an environment variable, so the
bootstrap fallbacks [`deployment.md` §2](./deployment.md#2-required-environment-variables) lists
(`GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for an S3
artifact store, OAuth client credentials) can be added to it. The web dashboard receives none of
them. Back up `CONFIG_ENCRYPTION_KEY`: every credential stored in the database is sealed with it.

Then install:

```bash
helm install auto-swe deploy/helm/auto-swe -n auto-swe \
  --set urls.api=https://api.example.com \
  --set urls.web=https://app.example.com \
  --set temporal.address=temporal-frontend.temporal:7233 \
  --set secrets.existingSecret=auto-swe-env \
  --set image.tag=<release-tag>
```

`urls.api`, `urls.web` and `temporal.address` are required, and so is either
`secrets.existingSecret` or the four `secrets.values.*` keys: the render fails without them.
`urls.api` becomes `PUBLIC_URL` and `BETTER_AUTH_URL` (GitHub and Slack call back to it, and it is
the issuer of the OAuth tokens MCP clients receive), and the dashboard's `NEXT_PUBLIC_API_URL`;
`urls.web` becomes `WEB_URL` and `CORS_ORIGIN`.

The chart does not seed the database. Once the migration has run, seed it once from a checkout of
the repository with `DATABASE_URL` pointing at it (`yarn db:seed`; [`deployment.md` §3](./deployment.md#3-database-setup)),
then continue with [`deployment.md` §2b](./deployment.md#2b-admin-ui-configuration-post-boot): a
model provider credential at `/models`, and GitHub at `/admin/integrations`, where **Create a
GitHub App** registers the instance's App from a manifest ([`github-app-setup.md`](./github-app-setup.md#creating-the-app-from-a-manifest)).

## 4. Values

| Value | Default | Meaning |
|---|---|---|
| `urls.api`, `urls.web` | — | The gateway's and the dashboard's public URLs (required) |
| `temporal.address` | — | `host:port` of the Temporal frontend (required) |
| `secrets.existingSecret` | — | A Secret holding `DATABASE_URL`, `CONFIG_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `JWT_SECRET` and any further variables |
| `secrets.values.*`, `secrets.extra` | empty | Used only without `existingSecret`: the chart renders a Secret from them |
| `image.registry`, `image.tag`, `image.<service>.digest` | `ghcr.io/yorch/auto-swe`, the chart's `appVersion`, — | A digest wins over the tag. Pin one in production; `main` moves |
| `image.pullPolicy` | `Always` | Because the default tag moves; `IfNotPresent` once pinned |
| `config.artifacts.s3.*` | off | An S3-compatible artifact store; the access keys go in the Secret |
| `config.artifacts.fs.existingClaim` | — | A ReadWriteMany claim mounted read-only into the gateway and read-write into the worker at `/var/lib/auto-swe/artifacts` (`ARTIFACT_FS_DIR`). With neither store, artifacts are kept in Postgres ([`deployment.md` §5c](./deployment.md#5c-choosing-an-object-store)) |
| `config.otelExporterEndpoint` | — | OTLP/gRPC collector; without it nothing is exported |
| `config.extraEnv`, `gateway.env`, `worker.env`, `web.env` | — | Further non-secret variables (`TRUST_PROXY`, `RATE_LIMIT_MAX`, `WORKSPACE_IMAGE`, …). `NODE_ENV` stays `production` |
| `gateway.replicas`, `web.replicas` | 2 | Both are stateless |
| `worker.enabled=false` | on | Leaves the worker out, to run it elsewhere against the same database and Temporal |
| `worker.proxies.modelPort` / `registryPort` / `egressPort` | 8790 / off / off | The worker's proxy ports, served through `<release>-worker-proxy` |
| `workspaces.namespace` | `auto-swe-workspaces` | Where workspace pods run (`K8S_WORKSPACE_NAMESPACE`) |
| `workspaces.manage` | true | Render that namespace's resources (section 1) |
| `workspaces.requireNetworkPolicy` | true | Only `false` skips the worker's start-up proof that the policy is enforced — for a local cluster |
| `workspaces.runtimeClassName`, `storageLimit`, `maxLifetimeSec`, `imagePullSecrets`, `quota` | —, `10Gi`, 86400, —, see `values.yaml` | The `K8S_WORKSPACE_*` settings and the namespace quota |
| `migrations.enabled=false` | on | Drops the migration hook Job; the gateway entrypoint still migrates at start |
| `ingress.*` | off | `className`, `annotations`, `tls` |
| `*.resources` | see `values.yaml` | Requests and memory limits per service; no CPU limits |

## 5. Migrations and upgrades

The migration Job runs the gateway image's own entrypoint, which applies pending migrations with
`prisma migrate deploy` (bounded at 120 seconds) and then runs its arguments, here a no-op `node`.
It is a `pre-install` / `pre-upgrade` hook, so a failed or timed-out migration fails the
`helm install` or `helm upgrade` before any pod of the new version starts. The gateway's
entrypoint runs the same command at every start; after the Job it finds nothing to apply, and
concurrent runs are serialised by Prisma's advisory lock. `prisma migrate dev` is never run.

`helm upgrade` replaces the worker (`Recreate`): it stops before the new one starts. Activities
that were running are retried by Temporal on the new worker according to their retry policies.

## Limitations

- **Workspaces run on the Kubernetes backend only.** Shell steps, container steps and sidecars need
  the Docker backend and fail with `WORKSPACE_BACKEND_UNSUPPORTED` here. The chart deploys no
  Docker-backed worker and no `docker-socket-proxy`; a deployment that needs those steps sets
  `worker.enabled=false` and runs the worker on an isolated Docker host
  ([`deployment.md` §5b](./deployment.md#5b-deploying-with-the-prod-compose-stack)).
- **One worker replica.** The model and registry proxies keep per-workspace state in memory, so the
  worker is not scaled out and is briefly absent during an upgrade.
- **No PostgreSQL or Temporal.** The chart has no subcharts for either, and Temporal's mTLS path is
  not wired in the services ([`deployment.md` §4](./deployment.md#4-temporal-setup)).
- **The chart does not seed the database**; the seed runs from a checkout of the repository.
- **A chart-rendered Secret is a hook resource.** So that it exists before the migration Job, it is
  created by the `pre-install` / `pre-upgrade` hooks, which delete and recreate it on every upgrade
  and leave it behind on `helm uninstall`. An `existingSecret` has neither behaviour.
- **The migration runs twice per rollout**: once in the Job and once, as a no-op, in each gateway
  pod's entrypoint.
- **The Ingress needs two hosts.** It routes `urls.api` and `urls.web` by hostname; a single-host
  layout with path routing needs an Ingress of your own (`ingress.enabled=false`).
- **No NetworkPolicy for the application pods.** Only the workspace namespace is fenced; restrict
  the release namespace with policies of your own.
- **The proxies' Service is reachable cluster-wide.** Each request needs a per-workspace token, but
  nothing at the network layer limits who may connect to the worker's proxy ports.
- **No CI job lints, renders or installs the chart.** Run `helm lint` and `helm template` against
  your values before installing.
