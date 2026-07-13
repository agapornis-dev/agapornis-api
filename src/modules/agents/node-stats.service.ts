import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AgentClientService } from '../agent-client/agent-client.service';
import { ApiConfigService } from '../../common/config/config.service';
import { AgentEntry, AgentsService } from './agents.service';

export interface NodeStatsRow extends AgentEntry {
  healthy: boolean;
  stats: Record<string, any>;
  lastSeenAgeSeconds?: number;
  collectedAt: string;
  uptimeSeconds?: number;
  responseTimeMs?: number;
  averageResponseTimeMs?: number;
  availabilityPercentage?: number;
  checksInWindow?: number;
  analyticsWindowSeconds?: number;
  responseTimeHistoryMs?: Array<number | null>;
  resourceHistory?: ResourceSample[];
  observedStatusSince?: string;
}

type StatsListener = (rows: NodeStatsRow[]) => void;
export type ResourceSample = {
  at: string;
  cpuPercentage: number | null;
  memoryPercentage: number | null;
  diskPercentage: number | null;
};
type HealthSample = ResourceSample & { healthy: boolean; responseTimeMs: number | null };

@Injectable()
export class NodeStatsService implements OnModuleInit, OnModuleDestroy {
  private readonly cache = new Map<string, NodeStatsRow>();
  private readonly listeners = new Set<StatsListener>();
  private readonly refreshIntervalMs: number;
  private readonly sampleLimit: number;
  private readonly samples = new Map<string, HealthSample[]>();
  private refreshTimer?: NodeJS.Timeout;
  private refreshPromise?: Promise<NodeStatsRow[]>;

  constructor(
    private readonly agents: AgentsService,
    private readonly client: AgentClientService,
    config: ApiConfigService
  ) {
    this.refreshIntervalMs = config.positiveInt('AGENT_STATS_REFRESH_INTERVAL_MS', 10_000);
    this.sampleLimit = config.positiveInt('AGENT_STATS_SAMPLE_WINDOW', 60);
  }

  onModuleInit() {
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.listeners.clear();
  }

  list() {
    const rows = this.snapshot();
    void this.refresh();
    return rows;
  }

  async listFresh() {
    const current = this.snapshot();
    if (current.some(row => row.healthy)) return current;
    return this.refresh();
  }

  subscribe(listener: StatsListener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    void this.refresh();
    return () => this.listeners.delete(listener);
  }

  refresh() {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = Promise.all(this.agents.list().map(agent => this.readLive(agent)))
      .then(rows => {
        const activeNodeIds = new Set(rows.map(row => row.nodeId));
        for (const nodeId of this.cache.keys()) {
          if (!activeNodeIds.has(nodeId)) {
            this.cache.delete(nodeId);
            this.samples.delete(nodeId);
          }
        }
        for (const row of rows) this.cache.set(row.nodeId, row);
        const snapshot = this.snapshot();
        for (const listener of this.listeners) listener(snapshot);
        return snapshot;
      })
      .finally(() => {
        this.refreshPromise = undefined;
      });

    return this.refreshPromise;
  }

  private snapshot() {
    return this.agents.list().map(agent => this.cache.get(agent.nodeId) || this.pendingRow(agent));
  }

  private async readLive(agent: AgentEntry): Promise<NodeStatsRow> {
    const startedAt = Date.now();
    try {
      const data: any = await this.client.getNodeStats(agent.nodeId);
      const responseTimeMs = Math.max(0, Date.now() - startedAt);
      return this.withAnalytics(this.onlineRow(agent, data), responseTimeMs);
    } catch (error: any) {
      return this.withAnalytics(
        this.offlineRow(agent, error?.details || error?.message || 'agent unavailable'),
        null
      );
    }
  }

  private onlineRow(agent: AgentEntry, data: any): NodeStatsRow {
    const collectedAt = new Date().toISOString();
    const stats = {
      ...data,
      status: data?.status || 'healthy',
      collectedAt
    };

    return {
      ...agent,
      healthy: stats.status === 'healthy',
      stats,
      uptimeSeconds: this.numeric(data?.uptime_seconds ?? data?.uptimeSeconds),
      lastSeenAgeSeconds: this.lastSeenAgeSeconds(agent.lastSeen),
      collectedAt
    };
  }

  private pendingRow(agent: AgentEntry): NodeStatsRow {
    const collectedAt = new Date().toISOString();
    return {
      ...agent,
      healthy: false,
      stats: { status: 'connecting', collectedAt },
      lastSeenAgeSeconds: this.lastSeenAgeSeconds(agent.lastSeen),
      collectedAt
    };
  }

  private offlineRow(agent: AgentEntry, errorMessage: string): NodeStatsRow {
    const collectedAt = new Date().toISOString();
    return {
      ...agent,
      healthy: false,
      stats: {
        status: 'offline',
        errorMessage,
        collectedAt
      },
      lastSeenAgeSeconds: this.lastSeenAgeSeconds(agent.lastSeen),
      collectedAt
    };
  }

  private lastSeenAgeSeconds(lastSeen?: string) {
    if (!lastSeen) return undefined;
    const age = Date.now() - new Date(lastSeen).getTime();
    return Number.isFinite(age) ? Math.max(0, Math.round(age / 1000)) : undefined;
  }

  private withAnalytics(row: NodeStatsRow, responseTimeMs: number | null): NodeStatsRow {
    const history = this.samples.get(row.nodeId) || [];
    const stats = row.stats || {};
    history.push({
      at: row.collectedAt,
      healthy: row.healthy,
      responseTimeMs,
      cpuPercentage: row.healthy ? this.percentage(stats.cpu_percentage ?? stats.cpuPercentage) : null,
      memoryPercentage: row.healthy ? this.ratioPercentage(
        stats.memory_usage_bytes ?? stats.memoryUsageBytes,
        stats.memory_total_bytes ?? stats.memoryTotalBytes,
      ) : null,
      diskPercentage: row.healthy ? this.ratioPercentage(
        stats.disk_usage_bytes ?? stats.diskUsageBytes,
        stats.disk_total_bytes ?? stats.diskTotalBytes,
      ) : null,
    });
    if (history.length > this.sampleLimit) history.splice(0, history.length - this.sampleLimit);
    this.samples.set(row.nodeId, history);

    const timings = history
      .map(sample => sample.responseTimeMs)
      .filter((value): value is number => value !== null);
    const averageResponseTimeMs = timings.length
      ? timings.reduce((sum, value) => sum + value, 0) / timings.length
      : undefined;
    const latestState = history[history.length - 1]?.healthy;
    let observedStatusSince = history[0]?.at;
    for (let index = history.length - 2; index >= 0; index -= 1) {
      if (history[index].healthy !== latestState) {
        observedStatusSince = history[index + 1].at;
        break;
      }
    }

    return {
      ...row,
      responseTimeMs: responseTimeMs ?? undefined,
      averageResponseTimeMs,
      availabilityPercentage: history.length
        ? history.filter(sample => sample.healthy).length / history.length * 100
        : undefined,
      checksInWindow: history.length,
      analyticsWindowSeconds: Math.round(this.refreshIntervalMs * this.sampleLimit / 1000),
      responseTimeHistoryMs: history.map(sample => sample.responseTimeMs),
      resourceHistory: history.map(sample => ({
        at: sample.at,
        cpuPercentage: sample.cpuPercentage,
        memoryPercentage: sample.memoryPercentage,
        diskPercentage: sample.diskPercentage,
      })),
      observedStatusSince
    };
  }

  private percentage(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
  }

  private ratioPercentage(used: unknown, total: unknown) {
    const usedNumber = Number(used);
    const totalNumber = Number(total);
    if (!Number.isFinite(usedNumber) || !Number.isFinite(totalNumber) || totalNumber <= 0) return null;
    return Math.max(0, Math.min(100, usedNumber / totalNumber * 100));
  }

  private numeric(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
  }

}
