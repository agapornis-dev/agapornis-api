import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { AgentsService } from '../agents/agents.service';
import { SecurityMaterialService } from '../auth/security-material.service';
import { ApiConfigService } from '../../common/config/config.service';
import { resolveProtoPath } from '../../common/proto-path';

const PROTO_PATH = resolveProtoPath('agent.proto');

@Injectable()
export class GrpcServerService implements OnModuleInit, OnModuleDestroy {
  private server?: grpc.Server;
  private readonly logger = new Logger('mTLS-Server');

  constructor(
    private readonly agents: AgentsService,
    private readonly securityMaterial: SecurityMaterialService,
    private readonly config: ApiConfigService,
  ) {}

  async onModuleInit() {
    await this.securityMaterial.initialize();
    const packageDef = protoLoader.loadSync(PROTO_PATH, { 
      keepCase: true, longs: String, enums: String, defaults: true, oneofs: true 
    });
    const proto: any = (grpc.loadPackageDefinition(packageDef) as any).agapornis.agent;

    this.server = new grpc.Server();

    this.server.addService(proto.AgentService.service, {
      Register: this.handleRegister.bind(this),
      Heartbeat: this.handleHeartbeat.bind(this)
    });

    const addr = this.config.get('GRPC_ADDR', '0.0.0.0:50051');
    const bundle = this.securityMaterial.certificateBundle();
    const creds = grpc.ServerCredentials.createSsl(
      bundle.caCertificate,
      [{ private_key: bundle.serverKey, cert_chain: bundle.serverCertificate }],
      true,
    );
    this.server.bindAsync(addr, creds, (err) => {
      if (err) return this.logger.error('gRPC bind failed', err);
      this.logger.log(`gRPC server listening on ${addr} (Pure mTLS)`);
    });
  }

  onModuleDestroy() {
    if (this.server) this.server.forceShutdown();
  }

  /**
   * Cryptographically extracts the Common Name (CN) from the client certificate.
   *
   * NOTE: This relies on an internal @grpc/grpc-js socket path. The optional
   * chaining ensures any path breakage fails with UNAUTHENTICATED rather than
   * allowing unauthenticated access — so the worst case is a rejected call.
   */
  private getClientIdentity(call: any): { commonName: string; fingerprint: string; serialNumber: string; expiresAt: string } {
    const socket = call.call?.stream?.session?.socket;
    if (!socket || typeof socket.getPeerCertificate !== 'function') {
      throw new Error('Unencrypted or invalid transport layer connection.');
    }

    const cert = socket.getPeerCertificate();
    if (!cert || !cert.subject || !cert.subject.CN) {
      throw new Error('Client certificate missing valid Common Name (CN).');
    }

    const expiresAt = new Date(cert.valid_to);
    return {
      commonName: cert.subject.CN,
      fingerprint: String(cert.fingerprint256 || cert.fingerprint || '').replace(/:/g, '').toLowerCase(),
      serialNumber: String(cert.serialNumber || ''),
      expiresAt: Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : ''
    };
  }

  private async handleRegister(call: any, callback: any) {
    try {
      const identity = this.getClientIdentity(call);
      const clientCN = identity.commonName;
      const requestedNodeId = call.request.nodeId;

      // 2. Enforce Scope: The certificate CN must match the Node ID they are trying to register
      if (clientCN !== requestedNodeId) {
        this.logger.warn(`Security Violation: Cert ${clientCN} tried to register as ${requestedNodeId}`);
        return callback({
          code: grpc.status.PERMISSION_DENIED,
          message: `Identity mismatch: Your certificate is for ${clientCN}`
        });
      }
      if (!this.agents.isCertificateAllowed(requestedNodeId, identity.fingerprint)) {
        return callback({
          code: grpc.status.PERMISSION_DENIED,
          message: 'Certificate has been revoked or is not registered for this node'
        });
      }
      await this.agents.rememberPresentedCertificate(requestedNodeId, {
        fingerprint: identity.fingerprint,
        serialNumber: identity.serialNumber,
        expiresAt: identity.expiresAt
      });
      
      await this.agents.register({ 
        nodeId: requestedNodeId, 
        fqdn: call.request.fqdn, 
        status: call.request.status || 'online' 
      });
      
      callback(null, { ok: true, message: 'registered via mTLS identity' });
    } catch (e: any) {
      callback({ code: grpc.status.UNAUTHENTICATED, message: e.message });
    }
  }

  private async handleHeartbeat(call: any, callback: any) {
    try {
      const identity = this.getClientIdentity(call);
      const clientCN = identity.commonName;
      const requestedNodeId = call.request.nodeId;

      if (clientCN !== requestedNodeId) {
        return callback({
          code: grpc.status.PERMISSION_DENIED,
          message: 'Identity mismatch'
        });
      }
      if (!this.agents.isCertificateAllowed(requestedNodeId, identity.fingerprint)) {
        return callback({
          code: grpc.status.PERMISSION_DENIED,
          message: 'Certificate has been revoked or is not registered for this node'
        });
      }
      // Replay-attack guard: reject heartbeats with a timestamp older than 60 s
      // or more than 10 s in the future (clock skew tolerance).
      const ts = Number(call.request.timestamp);
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (!ts || ts < nowSeconds - 60 || ts > nowSeconds + 10) {
        return callback({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'Heartbeat timestamp out of acceptable range'
        });
      }
      await this.agents.rememberPresentedCertificate(requestedNodeId, {
        fingerprint: identity.fingerprint,
        serialNumber: identity.serialNumber,
        expiresAt: identity.expiresAt
      });
      
      await this.agents.register({ 
        nodeId: requestedNodeId, 
        status: 'online', 
        fqdn: undefined 
      });
      
      callback(null, { ok: true });
    } catch (e: any) {
      callback({ code: grpc.status.UNAUTHENTICATED, message: e.message });
    }
  }
}
