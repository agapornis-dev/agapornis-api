import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AgentClientService } from '../agent-client/agent-client.service';
import { ApiConfigService } from '../../common/config/config.service';
import { AgentEntry, AgentsService } from './agents.service';

export interface CrowdSecAlertRow {
  id: string;
  nodeId: string;
  createdAt?: string;
  scenario?: string;
  message?: string;
  sourceScope?: string;
  sourceValue?: string;
  sourceIp?: string;
  sourceCountry?: string;
  sourceAsName?: string;
  eventsCount: number;
  simulated: boolean;
  remediation: boolean;
  decisionType?: string;
  decisionDuration?: string;
  severity: 'high' | 'medium' | 'low';
}

export interface CrowdSecNodeRow extends AgentEntry {
  enabled: boolean;
  supported: boolean;
  status: 'connecting' | 'active' | 'disabled' | 'unsupported' | 'unavailable';
  errorMessage?: string;
  collectedAt: string;
  alerts: CrowdSecAlertRow[];
}

type TelemetryListener = (rows: CrowdSecNodeRow[]) => void;

@Injectable()
export class CrowdSecTelemetryService implements OnModuleDestroy {
  private readonly cache = new Map<string, CrowdSecNodeRow>();
  private readonly listeners = new Set<TelemetryListener>();
  private readonly refreshIntervalMs: number;
  private refreshTimer?: NodeJS.Timeout;
  private refreshPromise?: Promise<CrowdSecNodeRow[]>;

  constructor(
    private readonly agents: AgentsService,
    private readonly client: AgentClientService,
    config: ApiConfigService
  ) {
    this.refreshIntervalMs = config.positiveInt('CROWDSEC_REFRESH_INTERVAL_MS', 15_000);
  }

  onModuleDestroy() {
    this.stopTimer();
    this.listeners.clear();
  }

  listFresh() {
    return this.refresh();
  }

  subscribe(listener: TelemetryListener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    if (this.listeners.size === 1) {
      void this.refresh();
      this.refreshTimer = setInterval(() => void this.refresh(), this.refreshIntervalMs);
      this.refreshTimer.unref?.();
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopTimer();
    };
  }

  refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = Promise.all(this.agents.list().map(agent => this.readNode(agent)))
      .then(rows => {
        const activeNodeIds = new Set(rows.map(row => row.nodeId));
        for (const nodeId of this.cache.keys()) {
          if (!activeNodeIds.has(nodeId)) this.cache.delete(nodeId);
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

  private async readNode(agent: AgentEntry): Promise<CrowdSecNodeRow> {
    try {
      const data: any = await this.client.getCrowdSecAlerts(agent.nodeId);
      const status = this.status(data?.status);
      const alerts = Array.isArray(data?.alerts)
        ? data.alerts.map((alert: any) => this.normalizeAlert(agent.nodeId, alert))
        : [];
      alerts.sort((left: CrowdSecAlertRow, right: CrowdSecAlertRow) =>
        this.timestamp(right.createdAt) - this.timestamp(left.createdAt)
      );
      return {
        ...agent,
        enabled: Boolean(data?.enabled),
        supported: Boolean(data?.supported),
        status,
        errorMessage: data?.error_message || data?.errorMessage || undefined,
        collectedAt: data?.collected_at || data?.collectedAt || new Date().toISOString(),
        alerts
      };
    } catch (error: any) {
      const unimplemented = Number(error?.code) === 12;
      return {
        ...agent,
        enabled: false,
        supported: !unimplemented,
        status: unimplemented ? 'unsupported' : 'unavailable',
        errorMessage: unimplemented
          ? 'Agent update required for CrowdSec telemetry.'
          : error?.details || error?.message || 'agent unavailable',
        collectedAt: new Date().toISOString(),
        alerts: []
      };
    }
  }

  private pendingRow(agent: AgentEntry): CrowdSecNodeRow {
    return {
      ...agent,
      enabled: false,
      supported: true,
      status: 'connecting',
      collectedAt: new Date().toISOString(),
      alerts: []
    };
  }

  private normalizeAlert(nodeId: string, alert: any): CrowdSecAlertRow {
    const decisionType = this.text(alert?.decision_type ?? alert?.decisionType);
    const remediation = Boolean(alert?.remediation);
    const simulated = Boolean(alert?.simulated);
    return {
      id: this.text(alert?.id) || `${nodeId}:${this.text(alert?.created_at ?? alert?.createdAt)}:${this.text(alert?.scenario)}`,
      nodeId,
      createdAt: this.text(alert?.created_at ?? alert?.createdAt) || undefined,
      scenario: this.text(alert?.scenario) || undefined,
      message: this.text(alert?.message) || undefined,
      sourceScope: this.text(alert?.source_scope ?? alert?.sourceScope) || undefined,
      sourceValue: this.text(alert?.source_value ?? alert?.sourceValue) || undefined,
      sourceIp: this.text(alert?.source_ip ?? alert?.sourceIp) || undefined,
      sourceCountry: this.text(alert?.source_country ?? alert?.sourceCountry) || undefined,
      sourceAsName: this.text(alert?.source_as_name ?? alert?.sourceAsName) || undefined,
      eventsCount: Math.max(0, Number(alert?.events_count ?? alert?.eventsCount ?? 0) || 0),
      simulated,
      remediation,
      decisionType: decisionType || undefined,
      decisionDuration: this.text(alert?.decision_duration ?? alert?.decisionDuration) || undefined,
      severity: simulated ? 'low' : remediation || decisionType === 'ban' ? 'high' : 'medium'
    };
  }

  private status(value: unknown): CrowdSecNodeRow['status'] {
    const status = String(value || '').toLowerCase();
    if (status === 'available') return 'active';
    if (status === 'error') return 'unavailable';
    return ['active', 'disabled', 'unsupported', 'unavailable'].includes(status)
      ? status as CrowdSecNodeRow['status']
      : 'unavailable';
  }

  private stopTimer() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private timestamp(value?: string) {
    const timestamp = value ? new Date(value).getTime() : 0;
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private text(value: unknown) {
    return value === undefined || value === null ? '' : String(value);
  }
}
