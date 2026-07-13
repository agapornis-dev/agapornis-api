import { Injectable } from '@nestjs/common';
import { AgentsService } from '../../agents/agents.service';
import { NodeStatsService } from '../../agents/node-stats.service';
import { ServerRegistryService } from './server-registry.service';
import { ServerDatabase, ServerDatabasesService } from './server-databases.service';

export interface PlacementDecision {
  nodeId: string;
  algorithm: 'least-memory-utilization';
  memoryUtilization: number;
  memoryUsageBytes: number;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  location: string;
  portRangeStart: number;
  portRangeEnd: number;
  availablePorts: number;
  diskAvailableBytes: number;
  maintenanceMode: boolean;
}

@Injectable()
export class ServerPlacementService {
  constructor(
    private readonly agents: AgentsService,
    private readonly nodeStats: NodeStatsService,
    private readonly registry: ServerRegistryService,
    private readonly databases: ServerDatabasesService
  ) {}

  async selectLeastMemoryUtilized(requiredMemoryBytes = 0, location?: string, nodeId?: string, requiredDiskBytes = 0): Promise<PlacementDecision> {
    const candidates = await this.rankLeastMemoryUtilized(requiredMemoryBytes, location, nodeId, requiredDiskBytes);
    return candidates[0];
  }

  async rankLeastMemoryUtilized(requiredMemoryBytes = 0, location?: string, nodeId?: string, requiredDiskBytes = 0): Promise<PlacementDecision[]> {
    const agents = this.agents.list();
    if (agents.length === 0) {
      throw new Error('no agents registered');
    }

    const liveRows = await this.nodeStats.listFresh();
    const byNodeId = new Map(liveRows.map(row => [row.nodeId, row]));
    const requestedLocation = this.normalizeLocation(location);
    const requestedNodeId = String(nodeId || '').trim();
    const locationAgents = requestedLocation
      ? agents.filter(agent => String(agent.location || '').trim().toLocaleLowerCase() === requestedLocation)
      : agents;
    if (locationAgents.length === 0) {
      throw new Error(requestedLocation ? `no nodes are configured in location "${requestedLocation}"` : 'no agents registered');
    }

    const candidateAgents = requestedNodeId
      ? locationAgents.filter(agent => agent.nodeId === requestedNodeId)
      : locationAgents;
    if (candidateAgents.length === 0 && requestedNodeId) {
      const registered = agents.some(agent => agent.nodeId === requestedNodeId);
      throw new Error(registered && requestedLocation
        ? `node "${requestedNodeId}" is not in location "${requestedLocation}"`
        : `node "${requestedNodeId}" is not registered`);
    }

    const snapshots = await Promise.all(candidateAgents.map(async agent => {
      const row = byNodeId.get(agent.nodeId);
      const stats: any = row?.stats || {};
      const memoryUsageBytes = this.numberValue(stats?.memory_usage_bytes ?? stats?.memoryUsageBytes);
      const memoryTotalBytes = this.numberValue(stats?.memory_total_bytes ?? stats?.memoryTotalBytes);
      const diskTotalBytes = this.numberValue(stats?.disk_total_bytes ?? stats?.diskTotalBytes);
      const memoryAvailableBytes = Math.max(0, memoryTotalBytes - memoryUsageBytes);
      const utilization = memoryTotalBytes > 0 ? memoryUsageBytes / memoryTotalBytes : Number.POSITIVE_INFINITY;

      const portRangeStart = Number(agent.portRangeStart || 0);
      const portRangeEnd = Number(agent.portRangeEnd || 0);
      const portCapacity = await this.registry.portCapacity(agent.nodeId, portRangeStart, portRangeEnd);
      const allocation = await this.allocationFor(agent.nodeId, memoryTotalBytes, diskTotalBytes, agent);
      return {
        agent,
        healthy: Boolean(row?.healthy) && memoryTotalBytes > 0 && diskTotalBytes > 0,
        memoryUsageBytes,
        memoryTotalBytes,
        memoryAvailableBytes,
        utilization,
        portRangeStart,
        portRangeEnd,
        portCapacity,
        allocation
      };
    }));

    const candidates = snapshots
      .filter(snapshot => snapshot.healthy)
      .filter(snapshot => !snapshot.agent.maintenanceMode)
      .filter(snapshot => requiredMemoryBytes <= 0 || snapshot.allocation.memoryAvailableBytes >= requiredMemoryBytes)
      .filter(snapshot => requiredDiskBytes <= 0 || snapshot.allocation.diskAvailableBytes >= requiredDiskBytes)
      .filter(snapshot => snapshot.portCapacity.available > 0)
      .sort((a, b) =>
        a.utilization - b.utilization ||
        b.memoryAvailableBytes - a.memoryAvailableBytes ||
        a.agent.nodeId.localeCompare(b.agent.nodeId)
      );

    if (candidates.length === 0) {
      const suffix = requestedNodeId
        ? ` on node "${requestedNodeId}"`
        : requestedLocation ? ` in location "${requestedLocation}"` : '';
      const hasHealthyAgent = snapshots.some(snapshot => snapshot.healthy);
      const hasConfiguredRange = snapshots.some(snapshot => snapshot.portCapacity.total > 0);
      const hasPortCapacity = snapshots.some(snapshot => snapshot.portCapacity.available > 0);
      const hasActiveNode = snapshots.some(snapshot => !snapshot.agent.maintenanceMode);
      if (!hasActiveNode) throw new Error(`all nodes${suffix} are in maintenance mode`);
      if (!hasConfiguredRange) throw new Error(`no nodes${suffix} have a valid game port range configured`);
      if (!hasPortCapacity) throw new Error(`all game ports are in use${suffix}`);
      throw new Error(hasHealthyAgent
        ? `no healthy node${suffix} has enough allocatable RAM or disk space`
        : `no healthy nodes are available${suffix}`);
    }

    return candidates.map(selected => ({
      nodeId: selected.agent.nodeId,
      algorithm: 'least-memory-utilization' as const,
      memoryUtilization: selected.utilization,
      memoryUsageBytes: selected.memoryUsageBytes,
      memoryTotalBytes: selected.memoryTotalBytes,
      memoryAvailableBytes: selected.memoryAvailableBytes,
      location: this.normalizeLocation(selected.agent.location),
      portRangeStart: selected.portRangeStart,
      portRangeEnd: selected.portRangeEnd,
      availablePorts: selected.portCapacity.available,
      diskAvailableBytes: selected.allocation.diskAvailableBytes,
      maintenanceMode: Boolean(selected.agent.maintenanceMode)
    }));
  }

  async capacityList() {
    const agents = this.agents.list();
    return Promise.all(agents.map(async agent => {
      const portRangeStart = Number(agent.portRangeStart || 0);
      const portRangeEnd = Number(agent.portRangeEnd || 0);
      const row = (await this.nodeStats.listFresh()).find(item => item.nodeId === agent.nodeId);
      const stats: any = row?.stats || {};
      const memoryTotalBytes = this.numberValue(stats?.memory_total_bytes ?? stats?.memoryTotalBytes);
      const diskTotalBytes = this.numberValue(stats?.disk_total_bytes ?? stats?.diskTotalBytes);
      return {
        nodeId: agent.nodeId,
        location: this.normalizeLocation(agent.location),
        portRangeStart: agent.portRangeStart,
        portRangeEnd: agent.portRangeEnd,
        maintenanceMode: Boolean(agent.maintenanceMode),
        ...(await this.allocationFor(agent.nodeId, memoryTotalBytes, diskTotalBytes, agent)),
        ...(await this.registry.portCapacity(agent.nodeId, portRangeStart, portRangeEnd))
      };
    }));
  }

  async allocations(nodeId: string) {
    const servers = (await this.registry.list()).filter(server => server.nodeId === nodeId);
    const gameAllocations = servers.flatMap(server => {
      const mappings = this.registry.portMappings(server.variables);
      const allocations = mappings.length ? mappings : [{ variable: 'SERVER_PORT', hostPort: server.assignedHostPort }];
      return allocations.map((mapping, index) => ({
        kind: 'server' as const,
        serverId: server.id,
        name: server.name,
        portVariable: mapping.variable,
        ownerUserId: server.ownerUserId,
        ipAddress: this.agents.connectionAddress(nodeId, mapping.hostPort).split(':')[0] || '',
        port: mapping.hostPort,
        memoryBytes: index === 0 ? Number(server.memoryBytes || 0) : 0,
        diskLimitBytes: index === 0 ? this.allocatedServerStorage(server) : 0,
        cpuLimitPercentage: index === 0 ? Number(server.cpuLimitPercentage || 0) : 0,
        status: server.status
      }));
    });
    const databaseAllocations = (await this.databases.listNodeDatabases(nodeId)).map((database: ServerDatabase) => ({
      kind: 'database' as const,
      serverId: database.serverId,
      databaseId: database.id,
      name: database.name,
      ownerUserId: undefined,
      ipAddress: database.host,
      port: database.port,
      memoryBytes: database.memoryBytes,
      diskLimitBytes: database.diskLimitBytes,
      cpuLimitPercentage: database.cpuLimitPercentage,
      status: database.status
    }));
    return [...gameAllocations, ...databaseAllocations].sort((a, b) => Number(a.port || 0) - Number(b.port || 0));
  }

  private async allocationFor(nodeId: string, memoryTotalBytes: number, diskTotalBytes: number, agent: any) {
    const servers = (await this.registry.list()).filter(server => server.nodeId === nodeId && server.status !== 'deleting');
    const memoryAllocatedBytes = servers.reduce((sum, server) => sum + Number(server.memoryBytes || 0), 0);
    const diskAllocatedBytes = servers.reduce((sum, server) => sum + this.allocatedServerStorage(server), 0);
    const memoryOverallocationBytes = Number(agent.memoryOverallocationBytes || 0);
    const diskOverallocationBytes = Number(agent.diskOverallocationBytes || 0);
    const memoryLimitBytes = this.effectiveLimit(agent.memoryLimitBytes, memoryTotalBytes);
    const diskLimitBytes = this.effectiveLimit(agent.diskLimitBytes, diskTotalBytes);
    const memoryCapacityBytes = memoryLimitBytes + memoryOverallocationBytes;
    const diskCapacityBytes = diskLimitBytes + diskOverallocationBytes;
    return {
      memoryPhysicalBytes: memoryTotalBytes,
      memoryBaseLimitBytes: memoryLimitBytes,
      memoryOverallocationBytes,
      memoryCapacityBytes,
      memoryAllocatedBytes,
      memoryAvailableBytes: Math.max(0, memoryCapacityBytes - memoryAllocatedBytes),
      diskPhysicalBytes: diskTotalBytes,
      diskBaseLimitBytes: diskLimitBytes,
      diskOverallocationBytes,
      diskCapacityBytes,
      diskAllocatedBytes,
      diskAvailableBytes: Math.max(0, diskCapacityBytes - diskAllocatedBytes),
      serverCount: servers.length
    };
  }

  private effectiveLimit(configured: unknown, physical: number) {
    const limit = this.numberValue(configured);
    if (!limit) return physical;
    return physical > 0 ? Math.min(limit, physical) : limit;
  }

  private allocatedServerStorage(server: any) {
    const disk = Number(server.diskLimitBytes || 0);
    const variables = server.variables || {};
    const generalSwap = variables.AGAPORNIS_SWAP_MEMORY_STORAGE === 'general'
      ? Number(variables.AGAPORNIS_SWAP_MEMORY_MB || 0) * 1024 * 1024
      : 0;
    return disk + (Number.isFinite(generalSwap) && generalSwap > 0 ? generalSwap : 0);
  }

  private numberValue(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  private normalizeLocation(value: unknown) {
    return String(value || '').trim().toLocaleLowerCase();
  }
}
