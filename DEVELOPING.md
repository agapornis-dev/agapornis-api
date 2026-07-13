# Developing the Nest Master

Overview
- The Nest master provides an HTTP API and a gRPC server for agents.
- HTTP: administrative UI / issuance of short-lived JWTs (`/api/agents/:id/issue`).
- gRPC: agent-facing `AgentService` (see `protos/agent.proto`) listening on `GRPC_ADDR` (default `0.0.0.0:50051`).

Key files
- `src/auth/auth.service.ts` — key loading, JWT signing and verification.
- `src/agents/agents.service.ts` — in-memory registry of agents (Map keyed by nodeId).
- `src/grpc/grpc-server.service.ts` — starts a @grpc/grpc-js server and implements Register/Heartbeat handlers.
- `protos/agent.proto` — canonical proto for agent -> master communication.

Security model

- `src/auth/security-material.service.ts` owns the panel JWT secret, 2FA encryption key, private CA, and master mTLS identity.
- With PostgreSQL/MySQL, the `primary` row in `cluster_security` is authoritative. Local `keys/` files are compatibility copies, not replica identities.
- Existing complete `keys/` files and configured environment secrets seed an empty database once. Every later replica loads the database copy.
- The shared document contains private key material. Restrict database access and encrypt database traffic and backups.

- Agent authentication uses certificate common names and the shared CA. The private CA never leaves the API security boundary.

Sample Node agent (gRPC) — connect and register

```js
// Sample agent-side client using @grpc/grpc-js and @grpc/proto-loader
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const packageDef = protoLoader.loadSync('./protos/agent.proto');
const proto = grpc.loadPackageDefinition(packageDef).agapornis.agent;

const client = new proto.AgentService('master.example.com:50051', grpc.credentials.createInsecure());
const metadata = new grpc.Metadata();
metadata.add('authorization', 'Bearer <SHORT_LIVED_JWT>');

client.Register({ nodeId: 'node-01', fqdn: 'node-01.example.com' }, metadata, (err, resp) => {
  if (err) return console.error('register failed', err);
  console.log('registered', resp);
});
```

Testing & running
- `npm install`
- `npm run start:dev` to run in dev mode.
- Use `curl` for HTTP admin endpoints; use `grpcurl` or the sample Node client to exercise gRPC.

Extending
- Add more RPCs (e.g., ExecCommand, StreamLogs) to `protos/agent.proto` and implement handlers in `src/grpc/grpc-server.service.ts`.
- For scalability, replace in-memory `AgentsService` storage with a persistent store (Redis, Postgres) and consider long-lived connections / bidirectional streams.
