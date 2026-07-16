import { Injectable, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { DatabaseExecutor, DatabaseService } from '../../database/database.service';
import { ServerRecord, ServerRegistryService } from './server-registry.service';
import { DATABASE_CATALOG, DatabaseType, allowedDatabaseTypes, databasePortRangeMode, databaseType } from './database-catalog';

export interface ServerDatabase {
  id: string; serverId: string; nodeId: string; containerId: string; type: DatabaseType; name: string;
  databaseName: string; username: string; password: string; host: string; port: number; dockerImage: string;
  memoryBytes: number; diskLimitBytes: number; cpuLimitPercentage: number; cpuCores?: number; status: string; createdAt: string;
}

@Injectable()
export class ServerDatabasesService implements OnModuleInit {
  private readonly databases = new Map<string, ServerDatabase>();
  private readonly databasesFile = path.join(__dirname, '..', '..', '..', 'data', 'server-databases.json');

  constructor(
    private readonly client: AgentClientService,
    private readonly database: DatabaseService,
    private readonly registry: ServerRegistryService
  ) { this.load(); }

  async onModuleInit() {
    if (!this.database.enabled || this.databases.size === 0) return;
    const duplicateClause = this.database.clientType === 'postgres'
      ? ' ON CONFLICT (id) DO NOTHING'
      : ' ON DUPLICATE KEY UPDATE id = id';
    for (const entry of this.databases.values()) {
      await this.database.query(
        `INSERT INTO server_databases (id, server_id, node_id, container_id, type, name, database_name, username, password, host, port, docker_image, memory_bytes, disk_limit_bytes, cpu_limit_percentage, cpu_cores, status, created_at)
         VALUES (${this.database.placeholders(18)})${duplicateClause}`,
        this.params(entry)
      ).catch(() => undefined);
    }
  }

  async listServerDatabases(serverId: string) {
    if (this.database.enabled) {
      const rows = await this.database.query(`SELECT * FROM server_databases WHERE server_id = ${this.database.placeholders(1)} AND status <> 'deleting' ORDER BY created_at DESC`, [serverId]);
      return rows.map((row: any) => this.fromRow(row));
    }
    return Array.from(this.databases.values()).filter(item => item.serverId === serverId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listNodeDatabases(nodeId: string) {
    if (this.database.enabled) {
      const rows = await this.database.query(`SELECT * FROM server_databases WHERE node_id = ${this.database.placeholders(1)} AND status <> 'deleting' ORDER BY created_at DESC`, [nodeId]);
      return rows.map((row: any) => this.fromRow(row));
    }
    return Array.from(this.databases.values()).filter(item => item.nodeId === nodeId && item.status !== 'deleting');
  }

  async createServerDatabase(server: ServerRecord, input: { name?: string; type?: string }) {
    const name = String(input.name || 'default').trim() || 'default';
    const allowed = allowedDatabaseTypes(server.allowedDatabaseTypes, server.databaseDockerImage);
    const parsedType = databaseType(input.type);
    if (input.type && !parsedType) throw new Error(`unsupported database type '${input.type}'`);
    const requestedType = parsedType || allowed[0];
    if (!allowed.includes(requestedType)) throw new Error(`database type '${input.type}' is not allowed for this server`);
    const catalog = DATABASE_CATALOG[requestedType];
    const database: ServerDatabase = {
      id: crypto.randomUUID(), serverId: server.id, nodeId: server.nodeId, containerId: this.containerId(server.id), type: requestedType, name,
      databaseName: this.databaseName(server.id, name), username: this.username(), password: crypto.randomBytes(18).toString('base64url'),
      host: '', port: 0, dockerImage: catalog.image,
      memoryBytes: Number(server.databaseMemoryBytes || 512 * 1024 * 1024), diskLimitBytes: Number(server.databaseDiskLimitBytes || 1024 * 1024 * 1024),
      cpuLimitPercentage: Number(server.databaseCpuCores || 0) > 0 ? Number(server.databaseCpuCores) * 100 : Number(server.databaseCpuLimitPercentage || 50), cpuCores: undefined,
      status: 'provisioning', createdAt: new Date().toISOString()
    };
    database.host = database.containerId;

    if (this.database.enabled) await this.reserveSql(database);
    else {
      const limit = Number(server.databaseLimit || 0);
      if (!server.databasesEnabled || limit <= 0) throw new Error('databases are not enabled for this server');
      if ((await this.listServerDatabases(server.id)).length >= limit) throw new Error(`database limit reached (${limit}/${limit})`);
      database.port = await this.allocatePort(server);
      this.databases.set(database.id, database);
      this.saveDatabases();
    }

    try {
      const response: any = await this.client.createServer(server.nodeId, this.createRequest(database));
      if (response?.success === false) throw new Error(response?.error_message || response?.errorMessage || 'agent rejected database container create');
      database.status = 'created';
      await this.persistStatus(database);
      return database;
    } catch (error) {
      await this.releaseReservation(database.id);
      throw error;
    }
  }

  async deleteServerDatabase(serverId: string, databaseId: string) {
    const database = await this.claimForDelete(serverId, databaseId);
    try {
      const response: any = await this.client.deleteServer(database.nodeId, database.containerId);
      if (response?.success === false) throw new Error(response?.error_message || response?.errorMessage || 'agent rejected database container delete');
      if (this.database.enabled) await this.database.query(`DELETE FROM server_databases WHERE id = ${this.database.placeholders(1)} AND server_id = ${this.database.placeholders(1, 2)}`, [databaseId, serverId]);
      else { this.databases.delete(databaseId); this.saveDatabases(); }
      return { id: databaseId, deleted: true };
    } catch (error) {
      database.status = 'created';
      await this.persistStatus(database);
      throw error;
    }
  }

  async deleteAllForServer(serverId: string, options: { skipAgent?: boolean } = {}) {
    const databases = await this.listServerDatabases(serverId);
    if (options.skipAgent) {
      if (this.database.enabled) {
        await this.database.query(
          `DELETE FROM server_databases WHERE server_id = ${this.database.placeholders(1)}`,
          [serverId]
        );
      } else {
        for (const database of databases) this.databases.delete(database.id);
        this.saveDatabases();
      }
      return { deleted: databases.map((database: ServerDatabase) => database.id), count: databases.length };
    }
    const deleted: string[] = [];
    for (const database of databases) {
      await this.deleteServerDatabase(serverId, database.id);
      deleted.push(database.id);
    }
    return { deleted, count: deleted.length };
  }

  async powerServerDatabase(serverId: string, databaseId: string, action: 'start' | 'stop' | 'restart' | 'reset') {
    const database = await this.getDatabase(serverId, databaseId);
    if (!database) throw new Error('database not found');
    const normalized = action === 'reset' ? 'restart' : action;
    const response: any = normalized === 'start' ? await this.client.startServer(database.nodeId, database.containerId)
      : normalized === 'stop' ? await this.client.stopServer(database.nodeId, database.containerId)
      : await this.client.restartServer(database.nodeId, database.containerId);
    if (response?.success === false) throw new Error(response?.error_message || response?.errorMessage || `agent rejected database ${action}`);
    database.status = normalized === 'stop' ? 'stopped' : 'running';
    await this.persistStatus(database);
    return database;
  }

  async testServerDatabaseConnection(server: ServerRecord, databaseId: string) {
    const database = await this.getDatabase(server.id, databaseId);
    if (!database) throw new Error('database not found');
    const catalog = DATABASE_CATALOG[database.type];
    const response: any = await this.client.testDatabaseConnection(server.nodeId, {
      server_id: server.id,
      database_type: database.type,
      host: database.host,
      port: database.port,
      database_name: database.databaseName,
      username: database.username,
      password: database.password,
      docker_image: catalog.image,
    });
    if (response?.success === false) throw new Error(response?.error_message || response?.errorMessage || 'database connection failed');
    return { success: true, latencyMs: Number(response?.latency_ms ?? response?.latencyMs ?? 0) };
  }

  async powerAllForServer(serverId: string, action: 'start' | 'stop' | 'restart') {
    const databases = await this.listServerDatabases(serverId);
    const updated: ServerDatabase[] = [];
    for (const database of databases) {
      updated.push(await this.powerServerDatabase(serverId, database.id, action));
    }
    return updated;
  }

  async recreateAllForServer(serverId: string) {
    const databases = await this.listServerDatabases(serverId);
    const updates: Array<{ database: ServerDatabase; image: string; previousImageId: string; imageId: string; imageChanged: boolean }> = [];
    for (const database of databases) {
      const response: any = await this.client.recreateServer(database.nodeId, database.containerId);
      if (response?.success === false) {
        throw new Error(response?.error_message || response?.errorMessage || `agent rejected database container update for ${database.name}`);
      }
      updates.push({
        database,
        image: String(response?.image || database.dockerImage || ''),
        previousImageId: String(response?.previous_image_id || response?.previousImageId || ''),
        imageId: String(response?.image_id || response?.imageId || ''),
        imageChanged: Boolean(response?.image_changed ?? response?.imageChanged)
      });
    }
    return updates;
  }

  async recreateTransferredDatabase(database: ServerDatabase, targetNodeId: string) {
    const response: any = await this.client.createServer(targetNodeId, this.createRequest(database));
    if (response?.success === false) {
      throw new Error(response?.error_message || response?.errorMessage || `target agent rejected database ${database.name}`);
    }
    return response;
  }

  async finalizeTransfer(serverId: string, targetNodeId: string) {
    if (this.database.enabled) {
      await this.database.query(
        `UPDATE server_databases SET node_id = ${this.database.placeholders(1)} WHERE server_id = ${this.database.placeholders(1, 2)}`,
        [targetNodeId, serverId]
      );
      return;
    }
    for (const entry of this.databases.values()) {
      if (entry.serverId === serverId) entry.nodeId = targetNodeId;
    }
    this.saveDatabases();
  }

  private async reserveSql(entry: ServerDatabase) {
    await this.database.transaction(async tx => {
      await this.database.advisoryLock(tx, `database-quota:${entry.serverId}`);
      const rows = await tx.query(`SELECT node_id, databases_enabled, database_limit, database_port_range_mode, database_port_range_start, database_port_range_end FROM servers WHERE id = ${tx.placeholders(1)} FOR UPDATE`, [entry.serverId]);
      if (!rows[0]) throw new Error('server not found');
      const agents = await tx.query(`SELECT node_id, port_range_start, port_range_end FROM agents WHERE node_id = ${tx.placeholders(1)} FOR UPDATE`, [rows[0].node_id]);
      if (!agents[0]) throw new Error('server node not found');
      const limit = Number(rows[0].database_limit || 0);
      if (!rows[0].databases_enabled || limit <= 0) throw new Error('databases are not enabled for this server');
      const counts = await tx.query(`SELECT COUNT(*) AS count FROM server_databases WHERE server_id = ${tx.placeholders(1)} AND status <> 'deleting'`, [entry.serverId]);
      if (Number(counts[0]?.count || 0) >= limit) throw new Error(`database limit reached (${counts[0].count}/${limit})`);
      const gamePorts = await tx.query(`SELECT assigned_host_port AS port FROM servers WHERE node_id = ${tx.placeholders(1)} AND assigned_host_port IS NOT NULL`, [rows[0].node_id]);
      const databasePorts = await tx.query(`SELECT port FROM server_databases WHERE node_id = ${tx.placeholders(1)} AND status <> 'deleting'`, [rows[0].node_id]);
      const useGameRange = databasePortRangeMode(rows[0].database_port_range_mode) === 'game';
      entry.port = this.choosePort(
        useGameRange ? agents[0].port_range_start : rows[0].database_port_range_start,
        useGameRange ? agents[0].port_range_end : rows[0].database_port_range_end,
        [...gamePorts, ...databasePorts].map((row: any) => Number(row.port))
      );
      await this.insert(tx, entry);
    });
  }

  private async claimForDelete(serverId: string, databaseId: string) {
    if (!this.database.enabled) {
      const item = this.databases.get(databaseId);
      if (!item || item.serverId !== serverId) throw new Error('database not found');
      item.status = 'deleting'; this.saveDatabases(); return item;
    }
    return this.database.transaction(async tx => {
      const rows = await tx.query(`SELECT * FROM server_databases WHERE id = ${tx.placeholders(1)} AND server_id = ${tx.placeholders(1, 2)} FOR UPDATE`, [databaseId, serverId]);
      if (!rows[0] || rows[0].status === 'deleting') throw new Error('database not found or already deleting');
      await tx.query(`UPDATE server_databases SET status = 'deleting' WHERE id = ${tx.placeholders(1)}`, [databaseId]);
      return this.fromRow({ ...rows[0], status: 'deleting' });
    });
  }

  private async getDatabase(serverId: string, databaseId: string) {
    if (this.database.enabled) {
      const rows = await this.database.query(`SELECT * FROM server_databases WHERE id = ${this.database.placeholders(1)} AND server_id = ${this.database.placeholders(1, 2)} AND status <> 'deleting'`, [databaseId, serverId]);
      return rows[0] ? this.fromRow(rows[0]) : undefined;
    }
    const item = this.databases.get(databaseId); return item?.serverId === serverId ? item : undefined;
  }

  private async persistStatus(entry: ServerDatabase) {
    if (this.database.enabled) await this.database.query(`UPDATE server_databases SET status = ${this.database.placeholders(1)} WHERE id = ${this.database.placeholders(1, 2)}`, [entry.status, entry.id]);
    else { this.databases.set(entry.id, entry); this.saveDatabases(); }
  }
  private async releaseReservation(id: string) {
    if (this.database.enabled) await this.database.query(`DELETE FROM server_databases WHERE id = ${this.database.placeholders(1)} AND status = 'provisioning'`, [id]);
    else { this.databases.delete(id); this.saveDatabases(); }
  }
  private insert(tx: DatabaseExecutor, entry: ServerDatabase) {
    return tx.query(
      `INSERT INTO server_databases (id, server_id, node_id, container_id, type, name, database_name, username, password, host, port, docker_image, memory_bytes, disk_limit_bytes, cpu_limit_percentage, cpu_cores, status, created_at) VALUES (${tx.placeholders(18)})`,
      this.params(entry)
    );
  }
  private params(entry: ServerDatabase) { return [entry.id, entry.serverId, entry.nodeId, entry.containerId, entry.type, entry.name, entry.databaseName, entry.username, entry.password, entry.host, entry.port, entry.dockerImage, entry.memoryBytes, entry.diskLimitBytes, entry.cpuLimitPercentage, entry.cpuCores || null, entry.status, entry.createdAt]; }
  private createRequest(database: ServerDatabase) {
    const type = databaseType(database.type) || allowedDatabaseTypes(undefined, database.dockerImage)[0];
    const catalog = DATABASE_CATALOG[type];
    const credentials = type === 'postgres'
      ? [`POSTGRES_DB=${database.databaseName}`, `POSTGRES_USER=${database.username}`, `POSTGRES_PASSWORD=${database.password}`]
      : type === 'mysql'
        ? [`MYSQL_ROOT_PASSWORD=${crypto.randomBytes(24).toString('base64url')}`, `MYSQL_DATABASE=${database.databaseName}`, `MYSQL_USER=${database.username}`, `MYSQL_PASSWORD=${database.password}`]
        : [`MARIADB_ROOT_PASSWORD=${crypto.randomBytes(24).toString('base64url')}`, `MARIADB_DATABASE=${database.databaseName}`, `MARIADB_USER=${database.username}`, `MARIADB_PASSWORD=${database.password}`];
    return {
      server_id: database.containerId, docker_image: catalog.image, internal_port: `${database.port}/tcp`, host_port: 0,
      network_owner_id: database.serverId, expose_public_port: false,
      env_vars: [
        `AGAPORNIS_DATA_DIR=${catalog.dataDir}`, `AGAPORNIS_NETWORK_OWNER=${database.serverId}`, `AGAPORNIS_DATABASE_PORT=${database.port}`,
        ...credentials
      ],
      memory_bytes: database.memoryBytes, cpu_limit_percentage: database.cpuLimitPercentage, cpu_cores: database.cpuCores || 0,
      disk_limit_bytes: database.diskLimitBytes, startup_command: '', install_image: '', install_entrypoint: '', install_script: '', config_files_json: ''
    };
  }
  private fromRow(row: any): ServerDatabase { return { id: row.id, serverId: row.server_id, nodeId: row.node_id, containerId: row.container_id, type: databaseType(row.type) || 'mariadb', name: row.name, databaseName: row.database_name, username: row.username, password: row.password, host: row.host, port: Number(row.port), dockerImage: row.docker_image, memoryBytes: Number(row.memory_bytes), diskLimitBytes: Number(row.disk_limit_bytes), cpuLimitPercentage: Number(row.cpu_limit_percentage), cpuCores: row.cpu_cores ? Number(row.cpu_cores) : undefined, status: row.status, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at }; }
  private containerId(serverId: string) { return `db-${this.slug(serverId).slice(0, 36)}-${crypto.randomBytes(4).toString('hex')}`.slice(0, 63); }
  private databaseName(serverId: string, name: string) { return `db_${this.slug(serverId).slice(0, 14)}_${this.slug(name).slice(0, 18)}_${crypto.randomBytes(3).toString('hex')}`.slice(0, 64); }
  private username() { return `u_${crypto.randomBytes(8).toString('hex')}`; }
  private async allocatePort(server: ServerRecord) {
    const range = databasePortRangeMode(server.databasePortRangeMode) === 'game'
      ? await this.registry.nodePortRange(server.nodeId)
      : { start: server.databasePortRangeStart, end: server.databasePortRangeEnd };
    return this.choosePort(range.start, range.end, Array.from(await this.registry.usedPorts(server.nodeId)));
  }
  private choosePort(startValue: unknown, endValue: unknown, usedValues: number[]) {
    const start = Number(startValue || 33060);
    const end = Number(endValue || 33160);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) throw new Error('database port range must use whole numbers from 1 to 65535');
    const used = new Set(usedValues.filter(Number.isFinite));
    const available: number[] = [];
    for (let port = start; port <= end; port += 1) if (!used.has(port)) available.push(port);
    if (!available.length) throw new Error(`no available database ports in range ${start}-${end}`);
    return available[Math.floor(Math.random() * available.length)];
  }
  private slug(value: string) { return String(value || 'server').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'server'; }
  private load() { if (!fs.existsSync(this.databasesFile)) return; for (const item of JSON.parse(fs.readFileSync(this.databasesFile, 'utf8')) as ServerDatabase[]) this.databases.set(item.id, item); }
  private saveDatabases() { fs.mkdirSync(path.dirname(this.databasesFile), { recursive: true }); fs.writeFileSync(this.databasesFile, JSON.stringify(Array.from(this.databases.values()), null, 2)); }
}
