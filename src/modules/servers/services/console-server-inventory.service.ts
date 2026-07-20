import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { NodeStatsRow, NodeStatsService } from '../../agents/node-stats.service';
import { ServerRegistryService } from './server-registry.service';

@Injectable()
export class ConsoleServerInventoryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ConsoleServerInventoryService.name);
  private readonly bootstrapped = new Map<string, string>();
  private readonly unsupported = new Map<string, string>();
  private readonly instanceIds = new Map<string, string>();
  private readonly lastErrors = new Map<string, string>();
  private latestRows: NodeStatsRow[] = [];
  private reconcileRequested = false;
  private reconcilePromise?: Promise<void>;
  private unsubscribe?: () => void;

  constructor(
    private readonly nodeStats: NodeStatsService,
    private readonly registry: ServerRegistryService,
    private readonly agentClient: AgentClientService,
  ) {}

  onApplicationBootstrap() {
    this.unsubscribe = this.nodeStats.subscribe(rows => this.requestReconcile(rows));
  }

  onModuleDestroy() {
    this.unsubscribe?.();
  }

  private requestReconcile(rows: NodeStatsRow[]) {
    this.latestRows = rows;
    this.reconcileRequested = true;
    if (!this.reconcilePromise) this.reconcilePromise = this.drainReconciliations();
  }

  private async drainReconciliations() {
    try {
      while (this.reconcileRequested) {
        this.reconcileRequested = false;
        await this.reconcile(this.latestRows);
      }
    } catch (error: any) {
      this.logger.warn(`Unable to prepare console server inventory: ${error?.message || String(error)}`);
    } finally {
      this.reconcilePromise = undefined;
      if (this.reconcileRequested) this.reconcilePromise = this.drainReconciliations();
    }
  }

  private async reconcile(rows: NodeStatsRow[]) {
    const presentNodeIds = new Set(rows.map(row => row.nodeId));
    const trackedNodeIds = new Set([
      ...this.bootstrapped.keys(),
      ...this.unsupported.keys(),
      ...this.instanceIds.keys(),
      ...this.lastErrors.keys(),
    ]);
    for (const nodeId of trackedNodeIds) {
      if (presentNodeIds.has(nodeId)) continue;
      this.bootstrapped.delete(nodeId);
      this.unsupported.delete(nodeId);
      this.instanceIds.delete(nodeId);
      this.lastErrors.delete(nodeId);
    }

    const healthyRows = rows.filter(row => row.healthy);
    if (healthyRows.length === 0) return;

    const pending = healthyRows.filter(row => {
      const instanceId = String(row.stats?.agent_instance_id || row.stats?.agentInstanceId || '');
      const previousInstanceId = this.instanceIds.get(row.nodeId);
      if (instanceId && previousInstanceId && instanceId !== previousInstanceId) {
        this.bootstrapped.delete(row.nodeId);
        this.unsupported.delete(row.nodeId);
        this.lastErrors.delete(row.nodeId);
      }
      if (instanceId) this.instanceIds.set(row.nodeId, instanceId);
      const effectiveInstanceId = instanceId || previousInstanceId || '';

      // The inventory lives in the agent process. This lets a freshly restarted API
      // adopt an already-bootstrapped agent without retransmitting the full list.
      const inventoryInitialized = row.stats?.console_inventory_initialized === true
        || row.stats?.consoleInventoryInitialized === true;
      if (inventoryInitialized) {
        this.bootstrapped.set(row.nodeId, effectiveInstanceId);
        this.unsupported.delete(row.nodeId);
        this.lastErrors.delete(row.nodeId);
        return false;
      }

      return this.bootstrapped.get(row.nodeId) !== effectiveInstanceId
        && this.unsupported.get(row.nodeId) !== effectiveInstanceId;
    });

    if (pending.length === 0) return;
    const inventories = await this.registry.consoleServerIdsByNode();
    await Promise.all(pending.map(row => {
      const instanceId = this.instanceIds.get(row.nodeId) || '';
      return this.syncNode(row.nodeId, inventories.get(row.nodeId) || [], instanceId);
    }));
  }

  private async syncNode(nodeId: string, serverIds: string[], instanceId: string) {
    const normalized = Array.from(new Set(serverIds.map(String).filter(Boolean))).sort();

    try {
      const response: any = await this.agentClient.syncConsoleServers(nodeId, normalized);
      if (!response?.success) {
        throw new Error(response?.error_message || 'agent rejected its console server inventory');
      }

      this.bootstrapped.set(nodeId, instanceId);
      this.unsupported.delete(nodeId);
      this.lastErrors.delete(nodeId);
      this.logger.log(
        `Bootstrapped ${normalized.length} console server(s) on node ${nodeId}; ${Number(response.active_reader_count || 0)} reader(s) active`,
      );
    } catch (error: any) {
      if (error?.code === grpc.status.UNIMPLEMENTED) {
        this.unsupported.set(nodeId, instanceId);
        return;
      }

      const message = error?.details || error?.message || String(error);
      if (this.lastErrors.get(nodeId) !== message) {
        this.logger.warn(`Unable to synchronize console servers with node ${nodeId}: ${message}`);
        this.lastErrors.set(nodeId, message);
      }
    }
  }
}
