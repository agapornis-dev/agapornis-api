import { Injectable } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { AgentConnectionService, ObservedNodeCertificate } from './agent-connection.service';
import { ApiConfigService } from '../../common/config/config.service';
import { resolveProtoPath } from '../../common/proto-path';
export type { ObservedNodeCertificate } from './agent-connection.service';

const PROTO_PATH = resolveProtoPath('server.proto');

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});

const proto: any = (grpc.loadPackageDefinition(packageDef) as any).agapornis.v1;

function timeoutFromEnv(name: string, fallback: number): number {
  return new ApiConfigService().positiveInt(name, fallback);
}

const DEFAULT_GRPC_TIMEOUT_MS = timeoutFromEnv('AGENT_GRPC_TIMEOUT_MS', 120_000);

// Server lifecycle operations can be slow because of installs, mods, world generation, Docker pulls, etc.
const CREATE_SERVER_TIMEOUT_MS = timeoutFromEnv('AGENT_GRPC_CREATE_SERVER_TIMEOUT_MS', 3_600_000); // 1 hour
const DELETE_SERVER_TIMEOUT_MS = timeoutFromEnv('AGENT_GRPC_DELETE_SERVER_TIMEOUT_MS', 300_000); // 5 min
const UPDATE_TIMEOUT_MS = timeoutFromEnv('AGENT_GRPC_UPDATE_TIMEOUT_MS', 900_000); // 15 min
const BACKUP_TIMEOUT_MS = timeoutFromEnv('AGENT_GRPC_BACKUP_TIMEOUT_MS', 1_800_000); // 30 min
const STATS_TIMEOUT_MS = timeoutFromEnv('AGENT_GRPC_STATS_TIMEOUT_MS', 3_000); // 3 sec
const STATUS_TIMEOUT_MS = timeoutFromEnv('AGENT_GRPC_STATUS_TIMEOUT_MS', 10_000); // 10 sec
const CROWDSEC_TIMEOUT_MS = timeoutFromEnv('AGENT_GRPC_CROWDSEC_TIMEOUT_MS', 10_000); // 10 sec
const CERTIFICATE_TIMEOUT_MS = timeoutFromEnv('AGENT_GRPC_CERTIFICATE_TIMEOUT_MS', 300_000); // 5 min
const MAX_FILE_UPLOAD_BYTES = new ApiConfigService().positiveInt('AGAPORNIS_MAX_FILE_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024);

function writeGrpcStream(call: any, message: any): Promise<void> {
  if (call.write(message)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      call.removeListener('drain', onDrain);
      call.removeListener('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    call.once('drain', onDrain);
    call.once('error', onError);
  });
}

@Injectable()
export class AgentClientService {
  private readonly connections: AgentConnectionService;

  /**
   * Cached credentials — created once per node entry to avoid disk I/O per call.
   */
  constructor(connections: AgentConnectionService) {
    this.connections = connections;
  }

  invalidateNode(nodeId: string) {
    this.connections.invalidate(nodeId);
  }

  getObservedCertificate(nodeId: string) {
    return this.connections.observedCertificate(nodeId);
  }

  createServer(nodeId: string, req: any, token?: string) {
    return this.callServer(
      nodeId,
      'CreateServer',
      req,
      token,
      CREATE_SERVER_TIMEOUT_MS
    );
  }

  startServer(nodeId: string, serverId: string, token?: string) {
    return this.callServer(
      nodeId,
      'StartServer',
      { server_id: serverId },
      token
    );
  }

  stopServer(nodeId: string, serverId: string, token?: string) {
    return this.callServer(
      nodeId,
      'StopServer',
      { server_id: serverId },
      token
    );
  }

  restartServer(nodeId: string, serverId: string, token?: string) {
    return this.callServer(
      nodeId,
      'RestartServer',
      { server_id: serverId },
      token
    );
  }

  recreateServer(nodeId: string, serverId: string, token?: string) {
    return this.callServer(
      nodeId,
      'RecreateServer',
      { server_id: serverId },
      token,
      UPDATE_TIMEOUT_MS
    );
  }

  deleteServer(nodeId: string, serverId: string, token?: string) {
    return this.callServer(
      nodeId,
      'DeleteServer',
      { server_id: serverId },
      token,
      DELETE_SERVER_TIMEOUT_MS
    );
  }

  updateServerResources(nodeId: string, serverId: string, resources: any, token?: string) {
    return this.callServer(
      nodeId,
      'UpdateServerResources',
      {
        server_id: serverId,
        memory_bytes: resources.memoryBytes || resources.memory_bytes || 0,
        cpu_limit_percentage: resources.cpuLimitPercentage || resources.cpu_limit_percentage || 0,
        cpu_cores: 0,
        disk_limit_bytes: resources.diskLimitBytes || resources.disk_limit_bytes || 0,
        cpu_pinning: Boolean(resources.cpuPinning ?? resources.cpu_pinning ?? false),
        cpu_pinned_threads: resources.cpuPinnedThreads || resources.cpu_pinned_threads || '',
        swap_memory_bytes: resources.swapMemoryBytes || resources.swap_memory_bytes || 0,
        swap_memory_storage: resources.swapMemoryStorage || resources.swap_memory_storage || 'general'
      },
      token
    );
  }

  updateServerPorts(nodeId: string, serverId: string, portMappings: any[], token?: string) {
    return this.callServer(
      nodeId,
      'UpdateServerPorts',
      { server_id: serverId, port_mappings: portMappings },
      token,
      UPDATE_TIMEOUT_MS
    );
  }

  updateServerConfiguration(nodeId: string, configuration: any, token?: string) {
    return this.callServer(
      nodeId,
      'UpdateServerConfiguration',
      configuration,
      token,
      UPDATE_TIMEOUT_MS
    );
  }

  getNodeStats(nodeId: string, token?: string) {
    return this.callServer(
      nodeId,
      'GetNodeStats',
      {},
      token,
      STATS_TIMEOUT_MS
    );
  }

  getUpdateStatus(nodeId: string, token?: string) {
    return this.callServer(
      nodeId,
      'GetUpdateStatus',
      {},
      token,
      STATUS_TIMEOUT_MS
    );
  }

  applyUpdate(
    nodeId: string,
    request: { artifactUrl?: string; artifact_url?: string; sha256?: string },
    token?: string
  ) {
    return this.callServer(
      nodeId,
      'ApplyUpdate',
      {
        artifact_url: request.artifactUrl || request.artifact_url || '',
        sha256: request.sha256 || ''
      },
      token,
      UPDATE_TIMEOUT_MS
    );
  }

  restartForUpdate(nodeId: string, token?: string) {
    return this.callServer(
      nodeId,
      'RestartForUpdate',
      {},
      token,
      STATUS_TIMEOUT_MS
    );
  }

  installCertificate(nodeId: string, bundle: { cert: string; key: string; ca: string; fingerprint: string }) {
    return this.callServer(nodeId, 'InstallCertificate', {
      certificate_pem: bundle.cert,
      private_key_pem: bundle.key,
      ca_certificate_pem: bundle.ca,
      expected_fingerprint: bundle.fingerprint
    }, undefined, CERTIFICATE_TIMEOUT_MS);
  }

  rollbackCertificate(nodeId: string) {
    return this.callServer(nodeId, 'RollbackCertificate', {}, undefined, CERTIFICATE_TIMEOUT_MS);
  }

  getServerStats(nodeId: string, serverId: string, token?: string, signal?: AbortSignal) {
    return this.callServer(
      nodeId,
      'GetServerStats',
      { server_id: serverId },
      token,
      STATS_TIMEOUT_MS,
      signal
    );
  }

  sendCommand(nodeId: string, serverId: string, command: string, token?: string) {
    return this.callServer(
      nodeId,
      'SendCommand',
      { server_id: serverId, command },
      token
    );
  }

  streamConsole(nodeId: string, serverId: string, token?: string) {
    const client = this.serverClient(nodeId);

    const call = client.StreamConsole(
      { server_id: serverId },
      this.metadataFromToken(token)
    );
    call.once?.('metadata', () => void this.persistObservedCertificate(nodeId));
    return call;
  }

  uploadFile(
    nodeId: string,
    serverId: string,
    targetPath: string,
    stream: AsyncIterable<Buffer>,
    token?: string
  ) {
    const client = this.fileClient(nodeId);

    return new Promise((resolve, reject) => {
      const call = client.UploadFile(
        this.metadataFromToken(token),
        (err: any, resp: any) => {
          if (err) return reject(err);
          resolve(resp);
        }
      );

      call.on('error', reject);

      void (async () => {
        try {
          await writeGrpcStream(call, {
            metadata: {
              server_id: serverId,
              target_path: targetPath
            }
          });

          let totalBytes = 0;
          for await (const chunk of stream) {
            const data = Buffer.from(chunk);
            totalBytes += data.length;
            if (totalBytes > MAX_FILE_UPLOAD_BYTES) {
              throw new Error(`uploaded file exceeds the ${MAX_FILE_UPLOAD_BYTES} byte limit`);
            }
            await writeGrpcStream(call, {
              chunk_data: data
            });
          }

          call.end();
        } catch (error) {
          call.destroy(error as Error);
          reject(error);
        }
      })();
    });
  }

  deleteFileOrDirectory(nodeId: string, serverId: string, targetPath: string, token?: string) {
    return this.callFile(
      nodeId,
      'DeleteFileOrDirectory',
      {
        server_id: serverId,
        target_path: targetPath
      },
      token
    );
  }

  downloadFile(nodeId: string, serverId: string, targetPath: string, token?: string) {
    const client = this.fileClient(nodeId);

    return client.DownloadFile(
      {
        server_id: serverId,
        target_path: targetPath
      },
      this.metadataFromToken(token)
    );
  }

  listDirectory(nodeId: string, serverId: string, targetPath: string, token?: string) {
    return this.callFile(
      nodeId,
      'ListDirectory',
      {
        server_id: serverId,
        target_path: targetPath
      },
      token
    );
  }

  readFileContent(nodeId: string, serverId: string, targetPath: string, token?: string) {
    return this.callFile(
      nodeId,
      'ReadFileContent',
      {
        server_id: serverId,
        target_path: targetPath
      },
      token
    );
  }

  writeFileContent(
    nodeId: string,
    serverId: string,
    targetPath: string,
    content: string,
    token?: string
  ) {
    return this.callFile(
      nodeId,
      'WriteFileContent',
      {
        server_id: serverId,
        target_path: targetPath,
        content
      },
      token
    );
  }

  renameFileOrDirectory(nodeId: string, serverId: string, targetPath: string, newName: string, token?: string) {
    return this.callFile(nodeId, 'RenameFileOrDirectory', {
      server_id: serverId,
      target_path: targetPath,
      new_name: newName
    }, token);
  }

  createDirectory(nodeId: string, serverId: string, targetPath: string, token?: string) {
    return this.callFile(nodeId, 'CreateDirectory', {
      server_id: serverId,
      target_path: targetPath
    }, token);
  }

  moveFiles(nodeId: string, serverId: string, sourcePaths: string[], destinationPath: string, token?: string) {
    return this.callFile(nodeId, 'MoveFiles', {
      server_id: serverId,
      source_paths: sourcePaths,
      destination_path: destinationPath
    }, token);
  }

  createArchive(nodeId: string, serverId: string, sourcePaths: string[], destinationPath: string, token?: string) {
    return this.callFile(nodeId, 'CreateArchive', {
      server_id: serverId,
      source_paths: sourcePaths,
      destination_path: destinationPath
    }, token, timeoutFromEnv('AGENT_GRPC_ARCHIVE_TIMEOUT_MS', 300_000));
  }

  extractArchive(nodeId: string, serverId: string, targetPath: string, destinationPath: string, token?: string) {
    return this.callFile(nodeId, 'ExtractArchive', {
      server_id: serverId,
      target_path: targetPath,
      destination_path: destinationPath
    }, token, timeoutFromEnv('AGENT_GRPC_ARCHIVE_TIMEOUT_MS', 300_000));
  }

  installModpack(nodeId: string, serverId: string, targetPath: string, token?: string) {
    return this.callFile(nodeId, 'InstallModpack', {
      server_id: serverId,
      target_path: targetPath
    }, token, timeoutFromEnv('AGENT_GRPC_MODPACK_TIMEOUT_MS', 900_000));
  }

  // ---- Backup management ----

  createBackup(nodeId: string, serverId: string, options: { storage?: string; retentionCount?: number; encrypt?: boolean } = {}, token?: string) {
    return this.callBackup(
      nodeId,
      'CreateBackup',
      { server_id: serverId, storage: options.storage || 'local', retention_count: options.retentionCount || 0, encrypt: Boolean(options.encrypt) },
      token,
      BACKUP_TIMEOUT_MS
    );
  }

  listBackups(nodeId: string, serverId: string, includeRemote = false, token?: string) {
    return this.callBackup(
      nodeId,
      'ListBackups',
      { server_id: serverId, include_remote: includeRemote },
      token
    );
  }

  deleteBackup(nodeId: string, serverId: string, backupId: string, storage = 'local', token?: string) {
    return this.callBackup(
      nodeId,
      'DeleteBackup',
      {
        server_id: serverId,
        backup_id: backupId,
        storage
      },
      token,
      BACKUP_TIMEOUT_MS
    );
  }

  restoreBackup(nodeId: string, serverId: string, backupId: string, expectedChecksum?: string, storage = 'local', token?: string) {
    return this.callBackup(
      nodeId,
      'RestoreBackup',
      {
        server_id: serverId,
        backup_id: backupId,
        expected_checksum_sha256: expectedChecksum || '',
        storage
      },
      token,
      BACKUP_TIMEOUT_MS
    );
  }

  downloadBackup(nodeId: string, serverId: string, backupId: string, storage = 'local', token?: string) {
    const client = this.backupClient(nodeId);

    return client.DownloadBackup(
      {
        server_id: serverId,
        backup_id: backupId,
        storage
      },
      this.metadataFromToken(token)
    );
  }

  verifyBackup(nodeId: string, serverId: string, backupId: string, storage = 'local') {
    return this.callBackup(nodeId, 'VerifyBackup', { server_id: serverId, backup_id: backupId, storage }, undefined, BACKUP_TIMEOUT_MS);
  }

  // ---- Node transfer: streams export → import directly to keep API memory stable ----

  pipeTransfer(
    sourceNodeId: string,
    targetNodeId: string,
    serverId: string,
    payload: 'server-data' | 'local-backups' = 'server-data',
    onProgress?: (transferredBytes: number, totalBytes: number) => void
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const sourceClient = this.transferClient(sourceNodeId);
      const targetClient = this.transferClient(targetNodeId);
      const transferPayload = payload === 'local-backups' ? 'LOCAL_BACKUPS' : 'SERVER_DATA';
      let transferredBytes = 0;
      let totalBytes = 0;
      let lastReportedPercent = -1;
      const reportProgress = () => {
        if (!onProgress) return;
        const percent = totalBytes > 0 ? Math.min(100, Math.floor((transferredBytes / totalBytes) * 100)) : 100;
        if (percent === lastReportedPercent) return;
        lastReportedPercent = percent;
        onProgress(transferredBytes, totalBytes);
      };
      let settled = false;
      const finish = (error?: any, response?: any) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(response);
      };

      const importCall = targetClient.ImportServer((err: any, resp: any) => {
        if (err) return finish(err);
        finish(undefined, resp);
      });

      const exportCall = sourceClient.ExportServer({
        server_id: serverId,
        payload: transferPayload
      });

      exportCall.on('data', (msg: any) => {
        let writable = true;
        if (msg.metadata) {
          totalBytes = Number(msg.metadata.archive_size_bytes || 0);
          reportProgress();
          writable = importCall.write({
            metadata: {
              server_id: msg.metadata.server_id,
              payload: msg.metadata.payload,
              archive_size_bytes: msg.metadata.archive_size_bytes
            }
          });
        } else if (msg.chunk_data) {
          transferredBytes += Number(msg.chunk_data.length || msg.chunk_data.byteLength || 0);
          reportProgress();
          writable = importCall.write({
            chunk_data: msg.chunk_data
          });
        }
        if (!writable) exportCall.pause();
      });

      importCall.on('drain', () => exportCall.resume());

      exportCall.on('error', (err: any) => {
        importCall.cancel();
        finish(err);
      });

      exportCall.on('end', () => {
        importCall.end();
      });

      importCall.on('error', (err: any) => {
        exportCall.cancel();
        finish(err);
      });
    });
  }

  getCrowdSecAlerts(nodeId: string, token?: string) {
    return this.callServer(
      nodeId,
      'GetCrowdSecAlerts',
      {},
      token,
      CROWDSEC_TIMEOUT_MS
    );
  }

  deleteLocalBackups(nodeId: string, serverId: string) {
    return this.unary(this.transferClient(nodeId), 'DeleteLocalBackups', { server_id: serverId });
  }

  private callServer(
    nodeId: string,
    method: string,
    req: any,
    token?: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ) {
    return this.unary(
      this.serverClient(nodeId),
      method,
      req,
      token,
      timeoutMs,
      signal
    ).then(async response => {
      await this.persistObservedCertificate(nodeId);
      return response;
    });
  }

  private callFile(
    nodeId: string,
    method: string,
    req: any,
    token?: string,
    timeoutMs?: number
  ) {
    return this.unary(
      this.fileClient(nodeId),
      method,
      req,
      token,
      timeoutMs
    );
  }

  private callBackup(
    nodeId: string,
    method: string,
    req: any,
    token?: string,
    timeoutMs?: number
  ) {
    return this.unary(
      this.backupClient(nodeId),
      method,
      req,
      token,
      timeoutMs
    );
  }

  private unary(
    client: any,
    method: string,
    req: any,
    token?: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('agent request cancelled'));
        return;
      }
      const deadlineMs =
        Number.isFinite(timeoutMs) && Number(timeoutMs) > 0
          ? Number(timeoutMs)
          : DEFAULT_GRPC_TIMEOUT_MS;

      const deadline = new Date(Date.now() + deadlineMs);

      let call: any;
      const cancel = () => call?.cancel?.();
      call = client[method](
        req,
        this.metadataFromToken(token),
        { deadline },
        (err: any, resp: any) => {
          signal?.removeEventListener('abort', cancel);
          if (err) return reject(err);
          resolve(resp);
        }
      );
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }

  testDatabaseConnection(nodeId: string, request: any, token?: string) {
    return this.callServer(
      nodeId,
      'TestDatabaseConnection',
      request,
      token,
      timeoutFromEnv('AGENT_GRPC_DATABASE_TEST_TIMEOUT_MS', 30_000)
    );
  }

  createServerWithProgress(
    nodeId: string,
    req: any,
    onProgress: (progress: { phase: string; progress: number; message: string }) => void,
    token?: string
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + CREATE_SERVER_TIMEOUT_MS);
      const call = this.serverClient(nodeId).CreateServerStream(
        req,
        this.metadataFromToken(token),
        { deadline }
      );
      let finalMessage: any;
      let settled = false;

      const finish = async (error?: any) => {
        if (settled) return;
        settled = true;
        if (error) return reject(error);
        await this.persistObservedCertificate(nodeId);
        if (!finalMessage) return reject(new Error('agent provisioning stream ended without a result'));
        resolve({
          success: Boolean(finalMessage.success),
          assigned_host_port: Number(finalMessage.assigned_host_port || 0),
          error_message: finalMessage.error_message || ''
        });
      };

      call.on('data', (message: any) => {
        if (message.complete) {
          finalMessage = message;
          return;
        }
        onProgress({
          phase: String(message.phase || 'creating'),
          progress: Number(message.progress || 0),
          message: String(message.message || 'Agent is provisioning the server')
        });
      });
      call.on('error', (error: any) => void finish(error));
      call.on('end', () => void finish());
    });
  }

  private serverClient(nodeId: string) {
    return this.cachedClient('server', proto.ServerManagement, nodeId);
  }

  private fileClient(nodeId: string) {
    return this.cachedClient('file', proto.FileManagement, nodeId);
  }

  private backupClient(nodeId: string) {
    return this.cachedClient('backup', proto.BackupManagement, nodeId);
  }

  private transferClient(nodeId: string) {
    return this.cachedClient('transfer', proto.NodeTransfer, nodeId);
  }

  private cachedClient(kind: string, ClientType: any, nodeId: string) {
    return this.connections.client(kind, ClientType, nodeId);
  }

  private async persistObservedCertificate(nodeId: string) {
    await this.connections.persistObservedCertificate(nodeId);
  }

  private metadataFromToken(token?: string) {
    return this.connections.metadata(token);
  }
}
