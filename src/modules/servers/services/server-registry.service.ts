import { Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../../database/database.service';
import { EggsService } from '../../eggs/eggs.service';

const CLIENT_HIDDEN_RESOURCE_VARIABLES = new Set([
  'MEMORY',
  'SERVER_MEMORY',
  'SERVER_DISK',
  'SERVER_CPU',
  'SERVER_CPU_CORES',
  'CPU_LIMIT',
  'CPU_CORES',
  'SERVER_IP',
  'STARTUP',
  'DOCKER_IMAGE',
  'SERVER_ID',
]);
import { allowedDatabaseTypes, databasePortRangeMode } from './database-catalog';
import {
  CollaboratorPermission,
  SERVER_PERMISSION_SCOPES,
  ServerAccess,
  ServerCollaborator,
  ServerPermissionScope,
  ServerRecord,
  ServerSettingsPatch,
} from './server-registry.types';

export type { CollaboratorPermission, ServerAccess, ServerCollaborator, ServerPermissionScope, ServerRecord, ServerSettingsPatch } from './server-registry.types';
export { SERVER_PERMISSION_SCOPES } from './server-registry.types';

@Injectable()
export class ServerRegistryService implements OnModuleInit {
  private readonly servers = new Map<string, ServerRecord>();
  private readonly dataFile = path.join(__dirname, '..', '..', '..', 'data', 'servers.json');

  constructor(
    private readonly database: DatabaseService,
    private readonly eggs: EggsService,
  ) {
    this.load();
  }

  async onModuleInit() {
    if (!this.database.enabled || this.servers.size === 0) return;
    for (const server of this.servers.values()) {
      const rows = await this.database.query(
        `SELECT id FROM servers WHERE id = ${this.database.placeholders(1)}`,
        [server.id]
      );
      if (!rows[0]) await this.upsert(server);
      for (const collaborator of server.collaborators || []) {
        await this.addCollaborator(server.id, collaborator.userId, collaborator.permission);
      }
    }
  }

  async list(user?: { id: string; role: string }) {
    const servers = await this.listInternal();
    if (!user) return servers;
    const visible = !this.isStaff(user.role)
      ? servers.filter(server => this.canAccess(server, user))
      : servers;
    return visible.map(server => this.forUser(server, user));
  }

  async listInternal() {
    if (this.database.enabled) {
      const rows = await this.database.query('SELECT * FROM servers ORDER BY created_at DESC');
      return this.withCollaboratorsForList(rows.map((row: any) => this.rowToRecord(row)));
    }

    return Array.from(this.servers.values());
  }

  async listAccessIndex(): Promise<ServerRecord[]> {
    if (this.database.enabled) {
      const rows = await this.database.query(
        'SELECT id, node_id, name, owner_user_id, status, created_at FROM servers ORDER BY created_at DESC'
      );
      const servers = rows.map((row: any) => ({
        id: row.id,
        nodeId: row.node_id,
        name: row.name,
        ownerUserId: row.owner_user_id || undefined,
        status: row.status,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
      })) as ServerRecord[];
      if (!servers.length) return servers;
      const ids = servers.map(server => server.id);
      const collaborators = await this.database.query(
        `SELECT server_id, user_id, permission, permissions FROM server_collaborators WHERE server_id IN (${this.database.placeholders(ids.length)})`,
        ids
      );
      const byServer = new Map<string, ServerCollaborator[]>();
      for (const row of collaborators) {
        const serverId = String(row.server_id);
        byServer.set(serverId, [...(byServer.get(serverId) || []), this.collaboratorRow(row)]);
      }
      return servers.map(server => ({
        ...server,
        collaboratorUserIds: (byServer.get(server.id) || []).map(collaborator => collaborator.userId),
        collaborators: byServer.get(server.id) || []
      }));
    }

    return Array.from(this.servers.values()).map(server => ({
      id: server.id,
      nodeId: server.nodeId,
      name: server.name,
      ownerUserId: server.ownerUserId,
      status: server.status,
      collaboratorUserIds: [...(server.collaboratorUserIds || [])],
      collaborators: [...(server.collaborators || [])],
      createdAt: server.createdAt
    }));
  }

  async get(id: string) {
    if (this.database.enabled) {
      const rows = await this.database.query(
        `SELECT * FROM servers WHERE id = ${this.database.placeholders(1)}`,
        [id]
      );
      return rows[0] ? this.withCollaborators(this.rowToRecord(rows[0])) : undefined;
    }

    return this.servers.get(id);
  }

  async upsert(record: ServerRecord) {
    if (this.database.enabled) {
      if (this.database.clientType === 'postgres') {
        await this.database.query(
          `INSERT INTO servers (id, node_id, name, egg_id, egg_change_allowed, allowed_egg_ids, owner_user_id, assigned_host_port, status, memory_bytes, cpu_limit_percentage, cpu_cores, disk_limit_bytes, databases_enabled, database_limit, database_memory_bytes, database_disk_limit_bytes, database_cpu_limit_percentage, database_cpu_cores, database_docker_image, allowed_database_types, database_port_range_mode, database_port_range_start, database_port_range_end, backup_limit, variables, created_at)
           VALUES (${this.database.placeholders(27)})
           ON CONFLICT (id) DO UPDATE SET
             node_id = EXCLUDED.node_id,
             name = EXCLUDED.name,
             egg_id = EXCLUDED.egg_id,
             egg_change_allowed = EXCLUDED.egg_change_allowed,
             allowed_egg_ids = EXCLUDED.allowed_egg_ids,
             owner_user_id = EXCLUDED.owner_user_id,
             assigned_host_port = EXCLUDED.assigned_host_port,
             status = EXCLUDED.status,
             memory_bytes = EXCLUDED.memory_bytes,
             cpu_limit_percentage = EXCLUDED.cpu_limit_percentage,
             cpu_cores = EXCLUDED.cpu_cores,
             disk_limit_bytes = EXCLUDED.disk_limit_bytes,
             databases_enabled = EXCLUDED.databases_enabled,
             database_limit = EXCLUDED.database_limit,
             database_memory_bytes = EXCLUDED.database_memory_bytes,
             database_disk_limit_bytes = EXCLUDED.database_disk_limit_bytes,
             database_cpu_limit_percentage = EXCLUDED.database_cpu_limit_percentage,
             database_cpu_cores = EXCLUDED.database_cpu_cores,
             database_docker_image = EXCLUDED.database_docker_image,
             allowed_database_types = EXCLUDED.allowed_database_types,
             database_port_range_mode = EXCLUDED.database_port_range_mode,
             database_port_range_start = EXCLUDED.database_port_range_start,
             database_port_range_end = EXCLUDED.database_port_range_end,
             backup_limit = EXCLUDED.backup_limit,
             variables = EXCLUDED.variables`,
          [
            record.id,
            record.nodeId,
            record.name,
            record.eggId || null,
            record.eggChangeAllowed ?? true,
            JSON.stringify(record.allowedEggIds || []),
            record.ownerUserId || null,
            record.assignedHostPort || null,
            record.status,
            record.memoryBytes || null,
            record.cpuLimitPercentage || null,
            record.cpuCores || null,
            record.diskLimitBytes || null,
            Boolean(record.databasesEnabled),
            record.databaseLimit || 0,
            record.databaseMemoryBytes || null,
            record.databaseDiskLimitBytes || null,
            record.databaseCpuLimitPercentage || null,
            record.databaseCpuCores || null,
            record.databaseDockerImage || null,
            JSON.stringify(allowedDatabaseTypes(record.allowedDatabaseTypes, record.databaseDockerImage)),
            databasePortRangeMode(record.databasePortRangeMode),
            record.databasePortRangeStart || null,
            record.databasePortRangeEnd || null,
            record.backupLimit ?? 0,
            JSON.stringify(record.variables || {}),
            record.createdAt
          ]
        );
      } else {
        await this.database.query(
          `REPLACE INTO servers (id, node_id, name, egg_id, egg_change_allowed, allowed_egg_ids, owner_user_id, assigned_host_port, status, memory_bytes, cpu_limit_percentage, cpu_cores, disk_limit_bytes, databases_enabled, database_limit, database_memory_bytes, database_disk_limit_bytes, database_cpu_limit_percentage, database_cpu_cores, database_docker_image, allowed_database_types, database_port_range_mode, database_port_range_start, database_port_range_end, backup_limit, variables, created_at)
           VALUES (${this.database.placeholders(27)})`,
          [
            record.id,
            record.nodeId,
            record.name,
            record.eggId || null,
            record.eggChangeAllowed ?? true,
            JSON.stringify(record.allowedEggIds || []),
            record.ownerUserId || null,
            record.assignedHostPort || null,
            record.status,
            record.memoryBytes || null,
            record.cpuLimitPercentage || null,
            record.cpuCores || null,
            record.diskLimitBytes || null,
            Boolean(record.databasesEnabled),
            record.databaseLimit || 0,
            record.databaseMemoryBytes || null,
            record.databaseDiskLimitBytes || null,
            record.databaseCpuLimitPercentage || null,
            record.databaseCpuCores || null,
            record.databaseDockerImage || null,
            JSON.stringify(allowedDatabaseTypes(record.allowedDatabaseTypes, record.databaseDockerImage)),
            databasePortRangeMode(record.databasePortRangeMode),
            record.databasePortRangeStart || null,
            record.databasePortRangeEnd || null,
            record.backupLimit ?? 0,
            JSON.stringify(record.variables || {}),
            record.createdAt
          ]
        );
      }
      return record;
    }

    this.servers.set(record.id, record);
    this.save();
    return record;
  }

  async reserve(record: ServerRecord): Promise<{ record: ServerRecord; replay: boolean }> {
    if (this.database.clientType !== 'postgres') {
      const existing = await this.get(record.id);
      if (existing) throw new Error('server id is already provisioning or exists');
      const reserved = { ...record, status: 'provisioning' };
      await this.upsert(reserved);
      return { record: reserved, replay: false };
    }
    return this.database.transaction(async tx => {
      await this.database.advisoryLock(tx, `server-id:${record.id}`);
      await this.database.advisoryLock(tx, `server-port-node:${record.nodeId}`);
      if (record.assignedHostPort) await this.database.advisoryLock(tx, `server-port:${record.nodeId}:${record.assignedHostPort}`);
      const rows = await tx.query(`SELECT * FROM servers WHERE id = $1 FOR UPDATE`, [record.id]);
      if (rows[0]) {
        const existing = this.rowToRecord(rows[0]);
        if (['created', 'running', 'stopped'].includes(existing.status)) return { record: existing, replay: true };
        throw new Error(`server is already ${existing.status}`);
      }
      await this.insertReserved(tx, record);
      return { record, replay: false };
    });
  }

  async reserveRandomPort(record: ServerRecord, start: number, end: number): Promise<{ record: ServerRecord; replay: boolean }> {
    const min = Math.min(start, end); const max = Math.max(start, end);
    if (this.database.clientType !== 'postgres') {
      const port = await this.allocateRandomPort(record.nodeId, min, max);
      return this.reserve({ ...record, assignedHostPort: port });
    }
    return this.database.transaction(async tx => {
      await this.database.advisoryLock(tx, `server-id:${record.id}`);
      await this.database.advisoryLock(tx, `server-port-node:${record.nodeId}`);
      const existingRows = await tx.query(`SELECT * FROM servers WHERE id = $1 FOR UPDATE`, [record.id]);
      if (existingRows[0]) {
        const existing = this.rowToRecord(existingRows[0]);
        if (['created', 'running', 'stopped'].includes(existing.status)) return { record: existing, replay: true };
        throw new Error(`server is already ${existing.status}`);
      }
      const ports = await tx.query(
        `SELECT candidate::int AS port FROM generate_series($1::int, $2::int) candidate
         WHERE NOT EXISTS (SELECT 1 FROM servers WHERE node_id = $3 AND assigned_host_port = candidate)
         ORDER BY random() LIMIT 1`,
        [min, max, record.nodeId]
      );
      if (!ports[0]) throw new Error(`no available ports in range ${min}-${max}`);
      const reserved = { ...record, assignedHostPort: Number(ports[0].port) };
      await this.insertReserved(tx, reserved);
      return { record: reserved, replay: false };
    });
  }

  isFrozen(server: ServerRecord | undefined) {
    return Boolean(server && (server.status === 'frozen' || server.variables?.AGAPORNIS_FROZEN === 'true'));
  }

  async assignPortAllocations(id: string, count: number, start: number, end: number, requestedVariables?: Record<string, string>) {
    const wanted = Math.max(1, Math.min(32, Math.floor(Number(count) || 1)));
    const min = Math.min(start, end); const max = Math.max(start, end);
    if (this.database.clientType === 'postgres') {
      return this.database.transaction(async tx => {
        const rows = await tx.query('SELECT * FROM servers WHERE id = $1 FOR UPDATE', [id]);
        if (!rows[0]) throw new Error('server reservation not found');
        const server = this.rowToRecord(rows[0]);
        await this.database.advisoryLock(tx, `server-port-node:${server.nodeId}`);
        const serverRows = await tx.query('SELECT assigned_host_port, variables FROM servers WHERE node_id = $1', [server.nodeId]);
        const databaseRows = await tx.query("SELECT port FROM server_databases WHERE node_id = $1 AND status <> 'deleting'", [server.nodeId]);
        const used = new Set<number>();
        for (const row of serverRows) {
          if (Number(row.assigned_host_port) > 0) used.add(Number(row.assigned_host_port));
          for (const mapping of this.portMappings(this.parseVariables(row.variables))) used.add(mapping.hostPort);
        }
        for (const row of databaseRows) if (Number(row.port) > 0) used.add(Number(row.port));
        const ports = this.allocateRequestedPorts(server, requestedVariables, wanted, min, max, used);
        const variables = this.withPortMappings(requestedVariables || server.variables, ports, server.variables);
        await tx.query('UPDATE servers SET variables = $1 WHERE id = $2', [JSON.stringify(variables), id]);
        return { ...server, variables };
      });
    }

    const server = await this.get(id);
    if (!server) throw new Error('server reservation not found');
    const used = await this.usedPorts(server.nodeId);
    const ports = this.allocateRequestedPorts(server, requestedVariables, wanted, min, max, used);
    const variables = this.withPortMappings(requestedVariables || server.variables, ports, server.variables);
    if (server.status === 'provisioning') await this.initializeProvisioningSettings(id, { variables });
    else await this.updateSettings(id, { variables });
    return { ...server, variables };
  }

  async reconcilePortAllocations(id: string, variables: Record<string, string>) {
    const server = await this.get(id);
    if (!server) throw new Error('server not found');
    const portKeys = Object.keys(variables).filter(key => /(^|_)PORT($|_)/i.test(key) && key !== 'AGAPORNIS_PORT_MAPPINGS');
    if (portKeys.length > 32) throw new Error('a server can have at most 32 ports');
    const internalPorts = portKeys.map(key => Number(variables[key]));
    if (internalPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new Error('port variables must contain a number between 1 and 65535');
    }
    if (new Set(internalPorts).size !== internalPorts.length) throw new Error('port variables must be unique');
    const count = Math.max(1, portKeys.length);
    const range = await this.nodePortRange(server.nodeId);
    return (await this.assignPortAllocations(id, count, range.start, range.end, variables)).variables || variables;
  }

  async finalizeProvisioning(id: string, assignedHostPort?: number) {
    if (this.database.clientType !== 'postgres') {
      const current = await this.get(id); if (!current) return undefined;
      const next = { ...current, assignedHostPort: assignedHostPort || current.assignedHostPort, status: 'created' };
      await this.upsert(next); return next;
    }
    return this.database.transaction(async tx => {
      await this.database.advisoryLock(tx, `server-id:${id}`);
      const rows = await tx.query(`SELECT * FROM servers WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new Error('server reservation not found');
      if (rows[0].status !== 'provisioning') throw new Error(`server cannot be finalized from status ${rows[0].status}`);
      await this.database.advisoryLock(tx, `server-port-node:${rows[0].node_id}`);
      const currentPort = rows[0].assigned_host_port ? Number(rows[0].assigned_host_port) : undefined;
      const finalPort = assignedHostPort || currentPort;
      await tx.query(`UPDATE servers SET assigned_host_port = $1, status = 'created' WHERE id = $2`, [finalPort || null, id]);
      return { ...this.rowToRecord(rows[0]), assignedHostPort: finalPort, status: 'created' };
    });
  }

  async releaseProvisioning(id: string) {
    if (this.database.enabled) {
      await this.database.query(`DELETE FROM servers WHERE id = ${this.database.placeholders(1)} AND status = 'provisioning'`, [id]);
    } else if (this.servers.get(id)?.status === 'provisioning') {
      this.servers.delete(id); this.save();
    }
  }

  async claimDeletion(id: string, allowProvisioning = false): Promise<{ record: ServerRecord; replay: boolean; previousStatus: string } | undefined> {
    if (this.database.clientType !== 'postgres') {
      const current = await this.get(id);
      if (!current) return undefined;
      if (current.status === 'deleting') return { record: current, replay: true, previousStatus: current.status };
      if (current.status === 'provisioning' && !allowProvisioning) throw new Error('server is still provisioning');
      const deleting = { ...current, status: 'deleting' };
      await this.upsert(deleting);
      return { record: deleting, replay: false, previousStatus: current.status };
    }

    return this.database.transaction(async tx => {
      await this.database.advisoryLock(tx, `server-id:${id}`);
      const rows = await tx.query(`SELECT * FROM servers WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) return undefined;
      const current = this.rowToRecord(rows[0]);
      if (current.status === 'deleting') return { record: current, replay: true, previousStatus: current.status };
      if (current.status === 'provisioning' && !allowProvisioning) throw new Error('server is still provisioning');
      const updated = await tx.query(`UPDATE servers SET status = 'deleting' WHERE id = $1 RETURNING *`, [id]);
      return { record: this.rowToRecord(updated[0]), replay: false, previousStatus: current.status };
    });
  }

  async restoreDeletion(id: string, status: string) {
    if (this.database.clientType === 'postgres') {
      const rows = await this.database.query(
        `UPDATE servers SET status = $1 WHERE id = $2 AND status = 'deleting' RETURNING *`,
        [status, id]
      );
      return rows[0] ? this.rowToRecord(rows[0]) : undefined;
    }
    const current = await this.get(id);
    if (!current || current.status !== 'deleting') return current;
    const restored = { ...current, status };
    await this.upsert(restored);
    return restored;
  }

  async claimTransition(id: string, transition: string): Promise<{ record: ServerRecord; previousStatus: string }> {
    if (this.database.clientType !== 'postgres') {
      const current = await this.get(id);
      if (!current) throw new Error('server not found');
      if (['provisioning', 'deleting', 'transferring'].includes(current.status)) throw new Error(`server is already ${current.status}`);
      await this.upsert({ ...current, status: transition });
      return { record: current, previousStatus: current.status };
    }
    return this.database.transaction(async tx => {
      await this.database.advisoryLock(tx, `server-id:${id}`);
      const rows = await tx.query(`SELECT * FROM servers WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new Error('server not found');
      const current = this.rowToRecord(rows[0]);
      if (['provisioning', 'deleting', 'transferring'].includes(current.status)) throw new Error(`server is already ${current.status}`);
      await tx.query(`UPDATE servers SET status = $1 WHERE id = $2`, [transition, id]);
      return { record: current, previousStatus: current.status };
    });
  }

  async restoreTransition(id: string, transition: string, status: string) {
    if (this.database.clientType === 'postgres') {
      const rows = await this.database.query(`UPDATE servers SET status = $1 WHERE id = $2 AND status = $3 RETURNING *`, [status, id, transition]);
      return rows[0] ? this.rowToRecord(rows[0]) : undefined;
    }
    const current = await this.get(id);
    if (!current || current.status !== transition) return current;
    const restored = { ...current, status };
    await this.upsert(restored);
    return restored;
  }

  async finalizeTransfer(id: string, targetNodeId: string, assignedHostPort: number | undefined, status: string) {
    if (this.database.clientType !== 'postgres') {
      const current = await this.get(id);
      if (!current || current.status !== 'transferring') throw new Error('server transfer is not active');
      const moved = { ...current, nodeId: targetNodeId, assignedHostPort: assignedHostPort || current.assignedHostPort, status };
      await this.upsert(moved);
      return moved;
    }
    return this.database.transaction(async tx => {
      await this.database.advisoryLock(tx, `server-id:${id}`);
      await this.database.advisoryLock(tx, `server-port-node:${targetNodeId}`);
      const rows = await tx.query(`SELECT * FROM servers WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0] || rows[0].status !== 'transferring') throw new Error('server transfer is not active');
      const port = assignedHostPort || (rows[0].assigned_host_port ? Number(rows[0].assigned_host_port) : null);
      const updated = await tx.query(
        `UPDATE servers SET node_id = $1, assigned_host_port = $2, status = $3 WHERE id = $4 RETURNING *`,
        [targetNodeId, port, status, id]
      );
      await tx.query(`UPDATE server_databases SET node_id = $1 WHERE server_id = $2`, [targetNodeId, id]);
      return this.rowToRecord(updated[0]);
    });
  }

  async setStatus(id: string, status: string) {
    if (this.database.clientType === 'postgres') {
      const rows = await this.database.query(
        `UPDATE servers SET status = $1 WHERE id = $2 AND status NOT IN ('provisioning', 'deleting', 'transferring') RETURNING *`,
        [status, id]
      );
      return rows[0] ? this.rowToRecord(rows[0]) : undefined;
    }
    const record = await this.get(id);
    if (!record) return undefined;
    const next = { ...record, status };
    await this.upsert(next);
    return next;
  }

  async updateSettings(id: string, patch: ServerSettingsPatch) {
    return this.writeSettings(id, patch, false);
  }

  async initializeProvisioningSettings(id: string, patch: ServerSettingsPatch) {
    return this.writeSettings(id, patch, true);
  }

  private async writeSettings(id: string, patch: ServerSettingsPatch, provisioningOnly: boolean) {
    if (this.database.clientType === 'postgres') {
      return this.database.transaction(async tx => {
        const rows = await tx.query(`SELECT * FROM servers WHERE id = $1 FOR UPDATE`, [id]);
        if (!rows[0]) return undefined;
        const status = String(rows[0].status || '');
        if (provisioningOnly && status !== 'provisioning') throw new Error('server provisioning initialization requires provisioning status');
        if (!provisioningOnly && ['provisioning', 'deleting', 'transferring'].includes(status)) throw new Error(`server settings cannot change while ${status}`);
        const columns: Record<string, string> = {
          name: 'name', variables: 'variables', memoryBytes: 'memory_bytes', cpuLimitPercentage: 'cpu_limit_percentage', cpuCores: 'cpu_cores', diskLimitBytes: 'disk_limit_bytes',
          databasesEnabled: 'databases_enabled', databaseLimit: 'database_limit', databaseMemoryBytes: 'database_memory_bytes', databaseDiskLimitBytes: 'database_disk_limit_bytes',
          databaseCpuLimitPercentage: 'database_cpu_limit_percentage', databaseCpuCores: 'database_cpu_cores', databaseDockerImage: 'database_docker_image',
          allowedDatabaseTypes: 'allowed_database_types', databasePortRangeMode: 'database_port_range_mode',
          databasePortRangeStart: 'database_port_range_start', databasePortRangeEnd: 'database_port_range_end', backupLimit: 'backup_limit',
          eggChangeAllowed: 'egg_change_allowed', allowedEggIds: 'allowed_egg_ids'
        };
        const entries = Object.entries(patch).filter(([key, value]) => columns[key] && value !== undefined);
        if (entries.length) {
          const values = entries.map(([key, value]) => ['variables', 'allowedEggIds', 'allowedDatabaseTypes'].includes(key) ? JSON.stringify(value || (key === 'variables' ? {} : [])) : value);
          const sets = entries.map(([key], index) => `${columns[key]} = $${index + 1}`).join(', ');
          await tx.query(`UPDATE servers SET ${sets} WHERE id = $${values.length + 1}`, [...values, id]);
        }
        const updated = await tx.query(`SELECT * FROM servers WHERE id = $1`, [id]);
        return this.rowToRecord(updated[0]);
      });
    }
    const record = await this.get(id);
    if (!record) return undefined;
    if (provisioningOnly && record.status !== 'provisioning') throw new Error('server provisioning initialization requires provisioning status');
    if (!provisioningOnly && ['provisioning', 'deleting', 'transferring'].includes(record.status)) throw new Error(`server settings cannot change while ${record.status}`);

    const next = {
      ...record,
      ...patch,
      variables: patch.variables ?? record.variables
    };

    await this.upsert(next);
    return next;
  }

  async remove(id: string) {
    if (this.database.enabled) {
      if (this.database.clientType === 'postgres') {
        await this.database.transaction(async tx => {
          await this.database.advisoryLock(tx, `server-id:${id}`);
          await tx.query(`DELETE FROM server_collaborators WHERE server_id = $1`, [id]);
          await tx.query(`DELETE FROM servers WHERE id = $1`, [id]);
        });
      } else {
        await this.database.query(`DELETE FROM server_collaborators WHERE server_id = ${this.database.placeholders(1)}`, [id]);
        await this.database.query(`DELETE FROM servers WHERE id = ${this.database.placeholders(1)}`, [id]);
      }
    } else {
      this.servers.delete(id);
      this.save();
    }

    return { id, deleted: true };
  }

  async usedPorts(nodeId?: string) {
    const servers = await this.list();
    const used = new Set(
      servers
        .filter((server: ServerRecord) => !nodeId || server.nodeId === nodeId)
        .map((server: ServerRecord) => server.assignedHostPort)
        .filter((port: number | undefined): port is number => Number.isFinite(port))
    );
    for (const server of servers.filter((entry: ServerRecord) => !nodeId || entry.nodeId === nodeId)) {
      for (const mapping of this.portMappings(server.variables)) used.add(mapping.hostPort);
    }
    if (!this.database) return used;
    if (this.database.enabled) {
      const rows = nodeId
        ? await this.database.query(`SELECT port FROM server_databases WHERE node_id = ${this.database.placeholders(1)} AND status <> 'deleting'`, [nodeId])
        : await this.database.query(`SELECT port FROM server_databases WHERE status <> 'deleting'`);
      for (const row of rows) if (Number.isFinite(Number(row.port))) used.add(Number(row.port));
    } else {
      const databaseFile = path.join(__dirname, '..', '..', '..', 'data', 'server-databases.json');
      if (fs.existsSync(databaseFile)) {
        const rows = JSON.parse(fs.readFileSync(databaseFile, 'utf8')) as Array<{ nodeId?: string; port?: number; status?: string }>;
        for (const row of rows) if ((!nodeId || row.nodeId === nodeId) && row.status !== 'deleting' && Number.isFinite(Number(row.port))) used.add(Number(row.port));
      }
    }
    return used;
  }

  async nodePortRange(nodeId: string) {
    if (this.database.enabled) {
      const rows = await this.database.query(
        `SELECT port_range_start, port_range_end FROM agents WHERE node_id = ${this.database.placeholders(1)}`,
        [nodeId]
      );
      if (!rows[0]) throw new Error('server node not found');
      return { start: Number(rows[0].port_range_start), end: Number(rows[0].port_range_end) };
    }
    const agentsFile = path.join(__dirname, '..', '..', '..', 'data', 'agents.json');
    const agents = fs.existsSync(agentsFile) ? JSON.parse(fs.readFileSync(agentsFile, 'utf8')) : [];
    const agent = agents.find((entry: any) => entry.nodeId === nodeId);
    if (!agent) throw new Error('server node not found');
    return { start: Number(agent.portRangeStart), end: Number(agent.portRangeEnd) };
  }

  async isPortInUse(nodeId: string, port: number) {
    return (await this.usedPorts(nodeId)).has(port);
  }

  async allocateRandomPort(nodeId: string, start: number, end: number) {
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) {
      throw new Error('invalid port range');
    }

    const used = await this.usedPorts(nodeId);
    const available: number[] = [];
    for (let port = min; port <= max; port += 1) {
      if (!used.has(port)) available.push(port);
    }

    if (available.length === 0) {
      throw new Error(`no available ports in range ${min}-${max}`);
    }

    return available[Math.floor(Math.random() * available.length)];
  }

  async portCapacity(nodeId: string, start: number, end: number) {
    const min = Math.min(Number(start), Number(end));
    const max = Math.max(Number(start), Number(end));
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 65535) {
      return { total: 0, used: 0, available: 0, exhausted: true };
    }
    const usedPorts = await this.usedPorts(nodeId);
    let used = 0;
    for (let port = min; port <= max; port += 1) {
      if (usedPorts.has(port)) used += 1;
    }
    const total = max - min + 1;
    const available = Math.max(0, total - used);
    return { total, used, available, exhausted: available === 0 };
  }

  private insertReserved(tx: any, record: ServerRecord) {
    return tx.query(
      `INSERT INTO servers (id, node_id, name, egg_id, egg_change_allowed, allowed_egg_ids, owner_user_id, assigned_host_port, status, memory_bytes, cpu_limit_percentage, cpu_cores, disk_limit_bytes, databases_enabled, database_limit, database_memory_bytes, database_disk_limit_bytes, database_cpu_limit_percentage, database_cpu_cores, database_docker_image, allowed_database_types, database_port_range_mode, database_port_range_start, database_port_range_end, backup_limit, variables, created_at)
       VALUES (${tx.placeholders(27)})`,
      this.recordParams({ ...record, status: 'provisioning' })
    );
  }

  private recordParams(record: ServerRecord) {
    return [record.id, record.nodeId, record.name, record.eggId || null, record.eggChangeAllowed ?? true, JSON.stringify(record.allowedEggIds || []), record.ownerUserId || null, record.assignedHostPort || null,
      record.status, record.memoryBytes || null, record.cpuLimitPercentage || null, record.cpuCores || null, record.diskLimitBytes || null,
      Boolean(record.databasesEnabled), record.databaseLimit || 0, record.databaseMemoryBytes || null, record.databaseDiskLimitBytes || null,
      record.databaseCpuLimitPercentage || null, record.databaseCpuCores || null, record.databaseDockerImage || null,
      JSON.stringify(allowedDatabaseTypes(record.allowedDatabaseTypes, record.databaseDockerImage)), databasePortRangeMode(record.databasePortRangeMode),
      record.databasePortRangeStart || null, record.databasePortRangeEnd || null, record.backupLimit ?? 0,
      JSON.stringify(record.variables || {}), record.createdAt];
  }

  canAccess(server: ServerRecord | undefined, user: { id: string; role: string }) {
    if (!server) return false;
    if (this.isStaff(user.role)) return true;
    return server.ownerUserId === user.id || Boolean(this.collaborator(server, user.id));
  }

  canWrite(server: ServerRecord | undefined, user: { id: string; role: string }) {
    if (!server) return false;
    if (['owner', 'admin'].includes(user.role)) return true;
    if (user.role === 'support') return false;
    if (server.ownerUserId === user.id) return true;
    return this.collaborator(server, user.id)?.permission === 'operator';
  }

  canManageAccess(server: ServerRecord | undefined, user: { id: string; role: string }) {
    if (!server) return false;
    return ['owner', 'admin'].includes(user.role) || server.ownerUserId === user.id;
  }

  async addCollaborator(serverId: string, userId: string, permission: CollaboratorPermission = 'read_only', permissions: ServerPermissionScope[] = []) {
    const server = await this.get(serverId);
    if (!server) throw new Error('server not found');
    if (server.ownerUserId === userId) throw new Error('server owner already has access');

    if (this.database.enabled) {
      if (this.database.clientType === 'postgres') {
        await this.database.query(
          `INSERT INTO server_collaborators (server_id, user_id, permission, permissions, created_at)
           VALUES (${this.database.placeholders(5)}) ON CONFLICT (server_id, user_id) DO UPDATE SET permission = EXCLUDED.permission, permissions = EXCLUDED.permissions`,
          [serverId, userId, permission, JSON.stringify(this.scopes(permission, permissions)), new Date().toISOString()]
        );
      } else {
        await this.database.query(
          `INSERT INTO server_collaborators (server_id, user_id, permission, permissions, created_at) VALUES (${this.database.placeholders(5)})
           ON DUPLICATE KEY UPDATE permission = VALUES(permission), permissions = VALUES(permissions)`,
          [serverId, userId, permission, JSON.stringify(this.scopes(permission, permissions)), new Date().toISOString()]
        );
      }
      return this.get(serverId);
    }

    server.collaboratorUserIds = Array.from(new Set([...(server.collaboratorUserIds || []), userId]));
    server.collaborators = [
      ...(server.collaborators || []).filter((collaborator: ServerCollaborator) => collaborator.userId !== userId),
      { userId, permission, permissions: this.scopes(permission, permissions) }
    ];
    this.servers.set(serverId, server);
    this.save();
    return server;
  }

  async removeCollaborator(serverId: string, userId: string) {
    const server = await this.get(serverId);
    if (!server) throw new Error('server not found');
    if (this.database.enabled) {
      await this.database.query(
        `DELETE FROM server_collaborators WHERE server_id = ${this.database.placeholders(1)} AND user_id = ${this.database.placeholders(1, 2)}`,
        [serverId, userId]
      );
      return this.get(serverId);
    }

    server.collaboratorUserIds = (server.collaboratorUserIds || []).filter((id: string) => id !== userId);
    server.collaborators = (server.collaborators || []).filter((collaborator: ServerCollaborator) => collaborator.userId !== userId);
    this.servers.set(serverId, server);
    this.save();
    return server;
  }

  async removeUserCollaborations(userId: string) {
    if (this.database.enabled) {
      await this.database.query(`DELETE FROM server_collaborators WHERE user_id = ${this.database.placeholders(1)}`, [userId]);
      return;
    }
    for (const server of this.servers.values()) {
      server.collaboratorUserIds = (server.collaboratorUserIds || []).filter((id: string) => id !== userId);
      server.collaborators = (server.collaborators || []).filter(collaborator => collaborator.userId !== userId);
    }
    this.save();
  }

  isStaff(role: string) {
    return ['owner', 'admin', 'support'].includes(role);
  }

  forUser(server: ServerRecord, user: { id: string; role: string }) {
    const access = this.accessFor(server, user);
    const assignedPorts = this.portMappings(server.variables).map(mapping => mapping.hostPort);
    const canViewSettings = this.canPerform(server, user, 'settings');
    const canViewDatabases = this.canPerform(server, user, 'databases');
    const canViewBackups = this.canPerform(server, user, 'backups');
    const canManageResources = ['owner', 'admin'].includes(user.role);
    const exposeAccess = user.role !== 'user' || access.relationship !== 'owner';
    const { canManageAccess: _canManageAccess, ...clientAccess } = access;
    return {
      id: server.id,
      nodeId: server.nodeId,
      name: server.name,
      eggId: server.eggId,
      assignedPorts,
      assignedHostPort: server.assignedHostPort,
      status: server.status,
      memoryBytes: server.memoryBytes,
      cpuLimitPercentage: server.cpuLimitPercentage,
      cpuCores: server.cpuCores,
      diskLimitBytes: server.diskLimitBytes,
      databasesEnabled: canViewDatabases ? server.databasesEnabled : undefined,
      databaseLimit: canViewDatabases ? server.databaseLimit : undefined,
      allowedDatabaseTypes: canViewDatabases ? server.allowedDatabaseTypes : undefined,
      backupLimit: canViewBackups ? server.backupLimit : undefined,
      eggChangeAllowed: canViewSettings ? server.eggChangeAllowed : undefined,
      allowedEggIds: canViewSettings ? server.allowedEggIds : undefined,
      variables: canViewSettings
        ? this.clientVariables(
          server.variables,
          canManageResources,
          access.relationship === 'collaborator' ? this.userEditableVariableKeys(server.eggId) : undefined,
        )
        : undefined,
      ownerUserId: canManageResources ? server.ownerUserId : undefined,
      databaseMemoryBytes: canManageResources ? server.databaseMemoryBytes : undefined,
      databaseDiskLimitBytes: canManageResources ? server.databaseDiskLimitBytes : undefined,
      databaseCpuLimitPercentage: canManageResources ? server.databaseCpuLimitPercentage : undefined,
      databaseCpuCores: canManageResources ? server.databaseCpuCores : undefined,
      databaseDockerImage: canManageResources ? server.databaseDockerImage : undefined,
      databasePortRangeMode: canManageResources ? server.databasePortRangeMode : undefined,
      databasePortRangeStart: canManageResources ? server.databasePortRangeStart : undefined,
      databasePortRangeEnd: canManageResources ? server.databasePortRangeEnd : undefined,
      access: exposeAccess ? clientAccess : undefined,
      createdAt: server.createdAt
    };
  }

  private clientVariables(
    variables?: Record<string, string>,
    includePortMappings = false,
    allowedKeys?: Set<string>,
  ) {
    if (!variables) return undefined;
    return Object.fromEntries(
      Object.entries(variables).filter(([key]) =>
        (!allowedKeys || allowedKeys.has(key.toUpperCase()))
        &&
        !CLIENT_HIDDEN_RESOURCE_VARIABLES.has(key.toUpperCase())
        && (!key.startsWith('AGAPORNIS_') || (includePortMappings && key === 'AGAPORNIS_PORT_MAPPINGS'))
      )
    );
  }

  private userEditableVariableKeys(eggId?: string) {
    try {
      return this.eggs?.userEditableVariableKeys(eggId) || new Set<string>();
    } catch {
      // Deleted or unknown egg definitions must not turn into an information
      // disclosure. Persisted values remain available to the runtime.
      return new Set<string>();
    }
  }

  private rowToRecord(row: any): ServerRecord {
    return {
      id: row.id,
      nodeId: row.node_id,
      name: row.name,
      eggId: row.egg_id || undefined,
      eggChangeAllowed: row.egg_change_allowed === undefined || row.egg_change_allowed === null ? true : Boolean(row.egg_change_allowed),
      allowedEggIds: this.parseStringArray(row.allowed_egg_ids),
      ownerUserId: row.owner_user_id || undefined,
      assignedHostPort: row.assigned_host_port ? Number(row.assigned_host_port) : undefined,
      assignedPorts: this.portMappings(this.parseVariables(row.variables)).map(mapping => mapping.hostPort),
      status: row.status,
      memoryBytes: row.memory_bytes ? Number(row.memory_bytes) : undefined,
      cpuLimitPercentage: row.cpu_limit_percentage ? Number(row.cpu_limit_percentage) : undefined,
      cpuCores: row.cpu_cores ? Number(row.cpu_cores) : undefined,
      diskLimitBytes: row.disk_limit_bytes ? Number(row.disk_limit_bytes) : undefined,
      databasesEnabled: Boolean(row.databases_enabled),
      databaseLimit: row.database_limit ? Number(row.database_limit) : undefined,
      databaseMemoryBytes: row.database_memory_bytes ? Number(row.database_memory_bytes) : undefined,
      databaseDiskLimitBytes: row.database_disk_limit_bytes ? Number(row.database_disk_limit_bytes) : undefined,
      databaseCpuLimitPercentage: row.database_cpu_limit_percentage ? Number(row.database_cpu_limit_percentage) : undefined,
      databaseCpuCores: row.database_cpu_cores ? Number(row.database_cpu_cores) : undefined,
      databaseDockerImage: row.database_docker_image || undefined,
      allowedDatabaseTypes: allowedDatabaseTypes(this.parseStringArray(row.allowed_database_types), row.database_docker_image),
      databasePortRangeMode: databasePortRangeMode(row.database_port_range_mode),
      databasePortRangeStart: row.database_port_range_start ? Number(row.database_port_range_start) : undefined,
      databasePortRangeEnd: row.database_port_range_end ? Number(row.database_port_range_end) : undefined,
      backupLimit: row.backup_limit !== undefined ? Number(row.backup_limit) : 0,
      variables: this.parseVariables(row.variables),
      collaboratorUserIds: [],
      collaborators: [],
      createdAt: row.created_at
    };
  }

  private parseVariables(value: any) {
    if (!value) return undefined;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(String(value));
    } catch {
      return undefined;
    }
  }

  portMappings(variables?: Record<string, string>) {
    try {
      const parsed = JSON.parse(String(variables?.AGAPORNIS_PORT_MAPPINGS || '[]'));
      return Array.isArray(parsed) ? parsed.filter(item => Number(item?.hostPort) > 0) : [];
    } catch {
      return [];
    }
  }

  private withPortMappings(existing: Record<string, string> | undefined, ports: number[], previous?: Record<string, string>) {
    const variables = { ...(existing || {}) };
    const previousMappings = this.portMappings(previous);
    const previousKeys = previousMappings.map(mapping => String(mapping.variable));
    const isExpansion = ports.length > previousMappings.length;
    const configuredKeys = Object.keys(variables)
      .filter(key => /(^|_)PORT($|_)/i.test(key) && key !== 'AGAPORNIS_PORT_MAPPINGS')
      .sort((left, right) => {
        const leftIndex = previousKeys.indexOf(left); const rightIndex = previousKeys.indexOf(right);
        if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
        return left === 'SERVER_PORT' ? -1 : right === 'SERVER_PORT' ? 1 : left.localeCompare(right);
      });
    const mappings = ports.map((port, index) => {
      const selectedVariable = configuredKeys[index] || (index === 0 ? 'SERVER_PORT' : `ADDITIONAL_PORT_${index}`);
      // SERVER_PORT_N was the old generated name for otherwise unassigned
      // allocations. Normalize only newly appended entries; established egg
      // mappings retain their explicit variable names.
      const variable = /^SERVER_PORT_[2-9][0-9]*$/i.test(selectedVariable)
        ? `ADDITIONAL_PORT_${index}`
        : selectedVariable;
      if (variable !== selectedVariable) {
        variables[variable] = variables[selectedVariable];
        delete variables[selectedVariable];
      }
      // Keep the workload's configured/listening port separate from the
      // public node allocation. Rewriting SERVER_PORT to the host port would
      // modify server configuration files and prevent the new allocation
      // from being assigned to another service-specific port variable.
      const configuredPort = Number(variables[variable]);
      const previousInternalPort = Number(previousMappings.find(mapping => String(mapping.variable) === variable)?.internalPort);
      const generatedAdditionalPort = /^ADDITIONAL_PORT_[1-9][0-9]*$/i.test(variable);
      const internalPort = generatedAdditionalPort
        ? port
        : isExpansion && Number.isInteger(previousInternalPort) && previousInternalPort > 0 && previousInternalPort <= 65535
          ? previousInternalPort
          : Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
            ? configuredPort
            : port;
      variables[variable] = String(internalPort);
      return {
      variable,
      internalPort,
      hostPort: port,
      protocol: 'tcp'
    }; });
    variables.AGAPORNIS_PORT_MAPPINGS = JSON.stringify(mappings);
    return variables;
  }

  private allocateRequestedPorts(
    server: ServerRecord,
    requestedVariables: Record<string, string> | undefined,
    wanted: number,
    min: number,
    max: number,
    used: Set<number>
  ) {
    const currentMappings = this.portMappings(server.variables);
    const currentPorts = currentMappings.map(mapping => Number(mapping.hostPort)).filter(port => port > 0);
    for (const port of currentPorts) used.delete(port);
    if (server.assignedHostPort) used.delete(server.assignedHostPort);

    const requested = requestedVariables || server.variables || {};
    const previousKeys = currentMappings.map(mapping => String(mapping.variable));
    const configuredKeys = Object.keys(requested)
      .filter(key => /(^|_)PORT($|_)/i.test(key) && key !== 'AGAPORNIS_PORT_MAPPINGS')
      .sort((left, right) => {
        const leftIndex = previousKeys.indexOf(left); const rightIndex = previousKeys.indexOf(right);
        if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
        return left === 'SERVER_PORT' ? -1 : right === 'SERVER_PORT' ? 1 : left.localeCompare(right);
      });

    const primary = Number(server.assignedHostPort || currentPorts[0]);
    const ports = primary > 0 ? [primary] : [];
    for (let index = 1; index < wanted; index += 1) {
      const mapping = currentMappings[index];
      const variable = String(mapping?.variable || configuredKeys[index] || '');
      const isGeneratedAdditional = /^(?:ADDITIONAL_PORT_[1-9][0-9]*|SERVER_PORT_[2-9][0-9]*)$/i.test(variable);
      const isLegacyGeneratedAdditional = /^SERVER_PORT_[2-9][0-9]*$/i.test(variable);
      const explicitlyRequested = Number(requested[variable]);
      // An existing SERVER_PORT_N value represented its old container-side
      // port, not a requested host allocation. Preserve its recorded host
      // port while migrating it to ADDITIONAL_PORT_N.
      const candidate = mapping && isLegacyGeneratedAdditional
        ? Number(mapping.hostPort || 0)
        : isGeneratedAdditional && Number.isInteger(explicitlyRequested)
        ? explicitlyRequested
        : Number(mapping?.hostPort || 0);
      if (!candidate) continue;
      const isExplicitRequest = isGeneratedAdditional && Number.isInteger(explicitlyRequested) && !(mapping && isLegacyGeneratedAdditional);
      if (candidate < 1 || candidate > 65535) {
        if (isExplicitRequest) throw new Error(`requested port ${candidate} must be between 1 and 65535`);
        continue;
      }
      if (used.has(candidate) || ports.includes(candidate)) {
        if (isExplicitRequest) throw new Error(`requested port ${candidate} is already in use`);
        continue;
      }
      // Explicit additional allocations may be selected outside the node's
      // automatic range. Existing mappings are also retained if the range is
      // later narrowed; only automatically selected ports are range-bound.
      if (!isExplicitRequest && !mapping && (candidate < min || candidate > max)) continue;
      ports.push(candidate);
    }
    for (let port = min; port <= max && ports.length < wanted; port += 1) {
      if (!used.has(port) && !ports.includes(port)) ports.push(port);
    }
    if (ports.length !== wanted) throw new Error(`not enough available ports in range ${min}-${max}`);
    return ports;
  }

  private parseStringArray(value: any) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(String);
    try {
      const parsed = JSON.parse(String(value));
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  private load() {
    if (!fs.existsSync(this.dataFile)) return;
    const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as ServerRecord[];
    for (const server of parsed) {
      server.collaboratorUserIds ||= [];
      server.collaborators ||= server.collaboratorUserIds.map(userId => ({ userId, permission: 'operator', permissions: [...SERVER_PERMISSION_SCOPES] }));
      server.eggChangeAllowed ??= true;
      server.allowedEggIds ||= [];
      this.servers.set(server.id, server);
    }
  }

  private async withCollaborators(server: ServerRecord) {
    if (!this.database.enabled) return server;
    const rows = await this.database.query(
      `SELECT user_id, permission, permissions FROM server_collaborators WHERE server_id = ${this.database.placeholders(1)}`,
      [server.id]
    );
    const collaborators = rows.map((row: any) => this.collaboratorRow(row));
    return { ...server, collaboratorUserIds: collaborators.map((collaborator: ServerCollaborator) => collaborator.userId), collaborators };
  }

  private async withCollaboratorsForList(servers: ServerRecord[]) {
    if (!this.database.enabled || servers.length === 0) return servers;
    const ids = servers.map(server => server.id);
    const rows = await this.database.query(
      `SELECT server_id, user_id, permission, permissions FROM server_collaborators WHERE server_id IN (${this.database.placeholders(ids.length)})`,
      ids
    );
    const byServer = new Map<string, ServerCollaborator[]>();
    for (const row of rows) {
      const serverId = String(row.server_id);
      byServer.set(serverId, [...(byServer.get(serverId) || []), this.collaboratorRow(row)]);
    }
    return servers.map(server => {
      const collaborators = byServer.get(server.id) || [];
      return { ...server, collaboratorUserIds: collaborators.map(collaborator => collaborator.userId), collaborators };
    });
  }

  private collaborator(server: ServerRecord, userId: string) {
    return server.collaborators?.find(collaborator => collaborator.userId === userId)
      || (server.collaboratorUserIds?.includes(userId) ? { userId, permission: 'operator' as const, permissions: [...SERVER_PERMISSION_SCOPES] } : undefined);
  }

  private permission(value: unknown): CollaboratorPermission {
    return value === 'read_only' || value === 'custom' ? value : 'operator';
  }

  private accessFor(server: ServerRecord, user: { id: string; role: string }): ServerAccess {
    if (server.ownerUserId === user.id) return { relationship: 'owner', permission: 'owner', canWrite: true, canManageAccess: true, permissions: [...SERVER_PERMISSION_SCOPES] };
    if (['owner', 'admin'].includes(user.role)) return { relationship: 'staff', permission: 'staff', canWrite: true, canManageAccess: true, permissions: [...SERVER_PERMISSION_SCOPES] };
    if (user.role === 'support') return { relationship: 'staff', permission: 'staff', canWrite: false, canManageAccess: false, permissions: [] };
    const collaborator = this.collaborator(server, user.id);
    return {
      relationship: 'collaborator',
      permission: collaborator?.permission || 'read_only',
      canWrite: collaborator?.permission === 'operator',
      canManageAccess: false,
      permissions: this.scopes(collaborator?.permission || 'read_only', collaborator?.permissions || [])
    };
  }

  canPerform(server: ServerRecord | undefined, user: { id: string; role: string }, scope: ServerPermissionScope) {
    if (!server) return false;
    if (server.ownerUserId === user.id || ['owner', 'admin'].includes(user.role)) return true;
    if (user.role === 'support') return false;
    const collaborator = this.collaborator(server, user.id);
    return Boolean(collaborator && this.scopes(collaborator.permission, collaborator.permissions).includes(scope));
  }

  private collaboratorRow(row: any): ServerCollaborator {
    const permission = this.permission(row.permission);
    let parsed: unknown = [];
    try { parsed = typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions; } catch { parsed = []; }
    return { userId: String(row.user_id), permission, permissions: this.scopes(permission, Array.isArray(parsed) ? parsed : []) };
  }

  private scopes(permission: CollaboratorPermission, values: readonly unknown[]) {
    if (permission === 'operator') return [...SERVER_PERMISSION_SCOPES];
    if (permission === 'read_only') return ['console.view', 'files.view'] as ServerPermissionScope[];
    const allowed = new Set<string>(SERVER_PERMISSION_SCOPES);
    return Array.from(new Set(values.map(String).filter(value => allowed.has(value)))) as ServerPermissionScope[];
  }

  private save() {
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(Array.from(this.servers.values()), null, 2));
  }
}
