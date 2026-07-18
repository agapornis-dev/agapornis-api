# Agapornis Nest Master

> **Beta software:** Agapornis is under active development and may introduce breaking changes. Back up persistent data and test upgrades before using a new release.

NestJS master API for Agapornis agents. It manages panel users, RBAC, agent registration, Pterodactyl-style eggs, and HTTP/SSE proxy routes to the Rust agent gRPC API.

## Quick Start

```bash
cd agapornis-api
npm install
npm run start:dev
```

For a production build:

```bash
npm ci
npx tsc
NODE_ENV=production node dist/main.js
```

The recommended production layout binds the API to loopback HTTP and lets an existing NGINX or Traefik HTTPS entrypoint own certificate issuance and renewal:

```dotenv
API_HOST=127.0.0.1
PORT=3001
TRUST_PROXY=true
```

Do not expose port `3001` directly. Normal browser traffic reaches the API through the same-origin frontend proxy. If direct API clients need a public hostname, proxy `api.example.com` to `127.0.0.1:3001` and reuse the certificate resolver already configured in NGINX or Traefik. Native Fastify HTTPS remains optional for deployments without a TLS proxy; `API_TLS_CERT_PATH` and `API_TLS_KEY_PATH` enable it, while `API_TLS_CA_PATH` with `API_TLS_REQUIRE_CLIENT_CERT=true` adds native client-certificate validation.

The API creates its panel JWT secret, 2FA encryption key, private CA, and master mTLS identity on first boot. With PostgreSQL or MySQL these values are stored as one shared cluster security document and every replica uses the same material. With JSON fallback they remain instance-local in `data/security-material.json`.

## Database

The backend can run with Postgres, MySQL/MariaDB, or local JSON fallback.

Postgres:

```bash
DB_CLIENT=postgres DATABASE_URL=postgres://user:pass@localhost:5432/agapornis npm run start:dev
```

MySQL/MariaDB:

```bash
DB_CLIENT=mysql DATABASE_URL=mysql://user:pass@localhost:3306/agapornis npm run start:dev
```

You can also use `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`. The master creates tables for webhook targets, webhook event logs, and cronjobs automatically.

- `GET /api/system/database` returns current DB mode and connection status.

## Minecraft mod providers

Modrinth works without additional configuration. To include CurseForge results
in the Minecraft Mods browser, provide a CurseForge for Studios API key:

```bash
CURSEFORGE_API_KEY=your-api-key
```

Downloads are proxied by the API and restricted to official Modrinth and
ForgeCDN hosts. Mod and server-pack uploads are limited to 128 MB by the agent.

## Multiple API replicas

Agapornis can run multiple API instances behind a layer-7 load balancer. Set `API_CLUSTERED=true` (or `API_REPLICAS` above 1), point every replica at the same PostgreSQL database and Redis deployment, and enable `TRUST_PROXY=true` when the proxy supplies trusted forwarding headers. PostgreSQL is required because critical reservations and state transitions use its transactional advisory locks; MySQL remains supported for a single API process. Startup intentionally fails if clustered mode uses JSON/MySQL storage or has no Redis coordination. SSE and WebSocket clients may reconnect to any healthy replica; no sticky session is required.

The first database-backed replica atomically seeds the `primary` row in `cluster_security` from existing `keys/` files and `APP_JWT_SECRET` / `TWO_FACTOR_ENCRYPTION_KEY` when present. Later replicas load that row and replace their local certificate copies with the shared bundle. This preserves existing sessions and agent trust during migration while preventing independently generated replica keys. The row contains private key material, so database access, transport, and backups must be protected accordingly.

Environment secrets are seed values only after database storage is enabled. If a later replica supplies a different value, the database value remains authoritative and startup emits a warning.

## Host-native updates

The API, frontend, and Rust agent release independently from their own repositories. Each tagged release publishes a small `release-manifest.json` beside its checksummed artifact:

- `agapornis-api` publishes a source archive for the native Node.js service.
- `agapornis-frontend` publishes a source archive for the native Next.js service.
- `agapornis-agent-rust` publishes `linux-x86_64` and `linux-aarch64` binaries.

The Updates screen compares the installed API and frontend versions separately. Deploying downloads only newer components managed by the current updater host, verifies the declared size and SHA-256 hash, and writes a fixed update job. If automatic deployment is configured, the dedicated systemd unit applies it; otherwise the update remains staged for a manual `systemctl start agapornis-panel-update.service`. A frontend on another host is still reported, but it is not deployed by the API host unless that installation is explicitly managed there.

### Install the native update supervisor

The host needs Node.js 22, npm, `build-essential`, `curl`, `jq`, `tar`, `sudo`, and systemd. Builds run as the unprivileged `agapornis` service user; only the fixed supervisor unit runs as root.

The normal layout is:

```text
/etc/agapornis/                         protected environment files
/opt/agapornis/api/releases/<version>  versioned API releases
/opt/agapornis/frontend/releases/<version>
/opt/agapornis/*/current                active release symlinks
/var/lib/agapornis/                     persistent state and update jobs
```

Install the supplied units and updater as root:

```bash
install -d -m 0755 /opt/agapornis/updater
install -m 0755 deploy/apply-native-update.sh /opt/agapornis/updater/apply-native-update.sh
install -m 0644 deploy/agapornis-api.service /etc/systemd/system/agapornis-api.service
install -m 0644 deploy/agapornis-panel-update.service /etc/systemd/system/agapornis-panel-update.service
install -m 0440 deploy/agapornis-panel-update.sudoers /etc/sudoers.d/agapornis-panel-update
visudo -cf /etc/sudoers.d/agapornis-panel-update
systemctl daemon-reload
systemctl enable --now agapornis-api.service
```

Set these values in `/etc/agapornis/api.env`:

```dotenv
NODE_ENV=production
PORT=3001
AGAPORNIS_PANEL_UPDATE_DIR=/var/lib/agapornis/api/panel-updates
AGAPORNIS_PANEL_UPDATE_COMPONENTS=api
```

`AGAPORNIS_PANEL_UPDATE_COMPONENTS` is a comma-separated list of services installed on the updater host. It defaults to `api`; use `api,frontend` only when both local installations can be controlled by this supervisor. This prevents an API and frontend deployed on different hosts from being treated as one filesystem transaction.

No deployment command is required. Without one, the API verifies and stages updates and an administrator starts `agapornis-panel-update.service` manually. To allow the API to start the fixed updater unit automatically, optionally add `AGAPORNIS_PANEL_UPDATE_COMMAND=/usr/bin/sudo` and `AGAPORNIS_PANEL_UPDATE_ARGS=["/bin/systemctl","start","--no-block","agapornis-panel-update.service"]`. The updater runs in its own systemd cgroup, so it remains alive while the API is restarted and can perform post-restart health checks.

The legacy `AGAPORNIS_ROOT_DIR` and `AGAPORNIS_STATE_DIR` defaults remain supported. Independent layouts can set `AGAPORNIS_API_ROOT_DIR`, `AGAPORNIS_FRONTEND_ROOT_DIR`, `AGAPORNIS_API_STATE_DIR`, and `AGAPORNIS_FRONTEND_STATE_DIR`. Optional settings in `/etc/agapornis/update.env` also include `AGAPORNIS_API_HEALTH_URL`, `AGAPORNIS_FRONTEND_HEALTH_URL`, and `AGAPORNIS_UPDATE_HEALTH_ATTEMPTS`.

Public panel settings include the standard `Powered by Agapornis` credit. Normal API responses are not modified with watermark headers.

Release manifest URLs default to the public `agapornis-dev` repositories. `AGAPORNIS_API_RELEASE_MANIFEST_URL`, `AGAPORNIS_FRONTEND_RELEASE_MANIFEST_URL`, and `AGAPORNIS_AGENT_RELEASE_MANIFEST_URL` can point to an HTTPS mirror. `AGAPORNIS_PANEL_UPDATE_MAX_BYTES` defaults to 512 MiB, and `AGAPORNIS_PANEL_UPDATE_TIMEOUT_MS` marks a supervisor job failed after one hour without a result.

Agent update requests use the node's reported runtime identifier to select the matching Rust binary. `AGAPORNIS_AGENT_UPDATE_URL` and `AGAPORNIS_AGENT_UPDATE_SHA256` remain available as explicit per-deployment overrides.

### Publish an API release

Update `package.json` and `package-lock.json` to the same version, commit them, and push the matching tag:

```bash
npm version 0.2.0
git push origin main --follow-tags
```

`.github/workflows/release.yml` verifies TypeScript and the update tests, creates `agapornis-api-source.tar.gz`, generates its manifest, and attaches the native service files to the GitHub release. The workflow rejects a tag that does not equal `v<package version>`.

## Auth And RBAC

Password reset is email-only. Enable SMTP and set the public HTTPS panel URL under System Settings -> Brand Identity. `PANEL_PUBLIC_URL` remains an optional initial default. Reset links expire after 30 minutes, are single-use, and invalidate existing sessions after the password changes.

- `POST /api/auth/register` with `{ email, password, name }`
- `POST /api/auth/login` with `{ email, password }`
- `GET  /api/auth/me`
- `POST /api/auth/sessions/revoke-all` invalidates every JWT previously issued for the current account
- `GET  /api/auth/users`
- `PATCH /api/auth/users/:id/role` with `{ role }`

Invitation-key registration can be enabled in Panel Settings or with
`PANEL_REGISTRATION_INVITE_REQUIRED=true`. Administrators create single-use keys through
`POST /api/auth/invitations`, list unused keys with `GET /api/auth/invitations`, and revoke one
with `DELETE /api/auth/invitations/:id`. Only the SHA3-512 digest is stored; the plaintext key is
returned once when created and is submitted as `inviteKey` during registration.

The first registered user becomes `owner`. Later public registrations become `user`.

Roles:

- `user` can manage owned servers and explicitly granted collaborator actions.
- `support` adds support-ticket and limited operational access.
- `admin` can manage agents, eggs and users.
- `owner` has every permission.

API endpoints require `Authorization: Bearer <panel JWT>` unless stated otherwise. Panel JWTs use HS512 and a per-account session version; revoke-all, password reset, and role changes invalidate older versions. The Nest master mints short-lived node JWTs internally when it forwards calls to agents.

Authentication and role checks are global and deny access by default. Public
routes are explicitly marked in code and are limited to authentication entry
points, public panel settings, health checks, one-time agent bootstrap, and
secret-authenticated billing/incoming webhooks. Browser access uses the exact
origin allowlist in `CORS_ALLOWED_ORIGINS` (plus the configured panel URL).
State-changing requests authenticated by the session cookie must carry a
trusted `Origin` or `Referer`; bearer-authenticated API clients are not subject
to CSRF checks. API responses include a deny-all CSP, anti-framing, MIME
sniffing, referrer, cross-origin, permissions, and production HSTS headers.

## Agents

- `GET  /api/agents`
- `POST /api/agents/register` with `{ nodeId, fqdn, grpcAddress, grpcPort, secure }`
- `GET  /api/agents/public-key` returns the public key agents need during setup.
- `GET  /api/agents/updates` returns each agent's current version and staged-update status.
- `GET  /api/agents/stats` returns live resource, uptime, response-time, and rolling availability data.
- `GET  /api/agents/stats/stream` streams node status snapshots over SSE.
- `GET  /api/agents/crowdsec` returns normalized, read-only CrowdSec telemetry for opted-in Linux nodes.
- `GET  /api/agents/crowdsec/stream` streams those CrowdSec snapshots while an admin is viewing the page.
- `POST /api/agents/:id/update` stages an update artifact on the target agent.
- `POST /api/agents/:id/update/restart` safely restarts an agent only when it reports a verified staged update and a pending restart.
- `DELETE /api/agents/:id` removes an agent from the registry.
- `POST /api/agents/:id/issue` returns a short-lived node JWT for manual/debug use.

Connection defaults:

- Nest calls agents on `fqdn:443` by default. Set the registered gRPC port to `5001` for a directly exposed Rust agent, or keep `443` when a TLS proxy fronts the node.
- `grpcAddress`, `grpcPort`, or `secure` override this per node.
- `AGENT_GRPC_PORT` and `AGENT_GRPC_TLS=true|false` override defaults globally.
- `AGAPORNIS_AGENT_UPDATE_URL` and optional `AGAPORNIS_AGENT_UPDATE_SHA256` configure the artifact used by `POST /api/agents/:id/update`.
- `AGENT_STATS_REFRESH_INTERVAL_MS` controls node checks (default 5000 ms), while `AGENT_STATS_SAMPLE_WINDOW` controls the rolling analytics sample count (default 60).
- `CROWDSEC_REFRESH_INTERVAL_MS` controls the on-demand CrowdSec dashboard refresh (default 15000 ms). No periodic CrowdSec polling runs when there are no dashboard subscribers.
- The API issues node certificates from the shared private CA. Certificate metadata and revocation state remain in the shared `agents` table.

## Eggs

- `GET    /api/eggs`
- `GET    /api/eggs/:id`
- `POST   /api/eggs/import` imports a Pterodactyl-style egg JSON.
- `DELETE /api/eggs/:id`

Supported egg fields include `name`, `meta.name`, `description`, `meta.description`, `images`, `docker_images`, `startup`, `environment`, `variables`, `scripts.installation`, `config.stop`, `config.startup.done`, and JSON `config.files`. Configuration files support the `file`, `properties`, `ini`, `json`, `yaml`/`yml`, and `xml` parsers; JSON and YAML paths support array indexes and wildcards. Startup, install scripts, and config placeholders like `{{SERVER_MEMORY}}`, `{{env.SERVER_PORT}}`, or `{{server.build.default.port}}` are resolved before the server is created.

## Webhooks

- `GET    /api/webhooks/targets`
- `POST   /api/webhooks/targets` with `{ name, url, secret, events, headers }`
- `DELETE /api/webhooks/targets/:id`
- `GET    /api/webhooks/events`
- `POST   /api/webhooks/test/:id`
- `POST   /api/webhooks/pterodactyl` public inbound Pterodactyl event receiver
- `POST   /api/webhooks/incoming/:event` public inbound custom event receiver

Targets receive JSON bodies with `event`, `payload`, and `sentAt`. When a target has a secret, requests include `x-agapornis-signature: sha256=<hmac>`.

## Cronjobs

- `GET    /api/cronjobs`
- `POST   /api/cronjobs` with `{ name, intervalSeconds, eventType, webhookTargetId, payload }`
- `POST   /api/cronjobs/:id/run`
- `DELETE /api/cronjobs/:id`

Cronjobs dispatch events through the webhook target system. The minimum interval is 10 seconds.

## Servers

- `GET    /api/servers` lists assigned servers. Users only see servers they own or collaborate on; staff sees all servers.
- `GET    /api/servers/:id`
- `DELETE /api/servers/:id` removes stored server metadata.
- `POST   /api/agents/:id/servers`
- `POST   /api/agents/:id/servers/create` compatibility alias
- `POST   /api/agents/:id/servers/from-egg` with `{ eggId, serverId, userId, dockerImage, variables, memoryBytes, cpuLimitPercentage }`
- `POST   /api/agents/:id/servers/:serverId/start`
- `POST   /api/agents/:id/servers/:serverId/stop`
- `POST   /api/agents/:id/servers/:serverId/restart`
- `GET    /api/agents/:id/servers/:serverId/stats`
- `POST   /api/agents/:id/servers/:serverId/command` with `{ command }`
- `GET    /api/agents/:id/servers/:serverId/console` streams Server-Sent Events from the agent console.

Server lifecycle and console routes are available to users for servers they own or collaborate on. Staff roles can operate across managed servers, subject to route and service policy.

Server owners and administrators can share a server with either `read_only` or `operator`
permission. Read-only collaborators can inspect status, console output, activity, and files;
mutating routes such as power actions, console commands, file writes, backups, schedules,
databases, webhooks, and settings require operator access.

## Files

- `GET    /api/agents/:id/servers/:serverId/files?path=/`
- `GET    /api/agents/:id/servers/:serverId/files/content?path=/server.properties`
- `PUT    /api/agents/:id/servers/:serverId/files/content` with `{ path, content }`
- `POST   /api/agents/:id/servers/:serverId/files/upload?path=/plugins/mod.jar` with the raw file body
- `GET    /api/agents/:id/servers/:serverId/files/download?path=/world.zip`
- `DELETE /api/agents/:id/servers/:serverId/files?path=/old-file.txt`

Assigned users can manage server console, files, variables, webhooks, and egg changes when their collaborator permission allows it. Owners/admins are still required for CPU, memory, disk, and CPU-core limit changes.

## Server Egg Changes

- `POST /api/agents/:id/servers/:serverId/egg` with `{ eggId, dockerImage, variables }`

Changing an egg reinstalls the server content on the same node/server id and keeps the same owner and resource limits.

## WHMCS Provisioning

- `POST /api/webhooks/whmcs`

WHMCS requests require `x-agapornis-secret` or `x-whmcs-secret` matching `WHMCS_WEBHOOK_SECRET`. Buy/order/invoice-paid style events create or find a user account by customer email, provision the requested egg, and assign the server to that user. Supported defaults include `WHMCS_DEFAULT_EGG_ID` and `WHMCS_DEFAULT_NODE_ID`; payload fields and WHMCS custom/config options can override `eggId`, `nodeId`, `serverId`, `serverName`, and egg variables.

## gRPC Server

The master also runs an agent-facing gRPC server on `GRPC_ADDR` or `0.0.0.0:50051`, exposing `AgentService` from `protos/agent.proto`.

- `Register(RegisterRequest) returns (RegisterResponse)`
- `Heartbeat(HeartbeatRequest) returns (HeartbeatResponse)`

gRPC supports TLS if `keys/server.key` and `keys/server.crt` are present.
