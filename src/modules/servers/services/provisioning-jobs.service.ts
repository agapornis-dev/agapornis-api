import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../../redis/redis.service';

export type ProvisioningStatus = 'queued' | 'running' | 'complete' | 'failed';

export interface ProvisioningEvent {
  phase: string;
  progress: number;
  message: string;
  at: string;
}

export interface ProvisioningJob {
  id: string;
  serverId: string;
  nodeId?: string;
  kind?: string;
  requestedBy: string;
  status: ProvisioningStatus;
  phase: string;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  history: ProvisioningEvent[];
  result?: any;
  errorMessage?: string;
}

type JobListener = (job: ProvisioningJob) => void;
export type ProgressReporter = (phase: string, progress: number, message: string) => void;

interface JobPresentation {
  queuedMessage?: string;
  startingPhase?: string;
  startingProgress?: number;
  startingMessage?: string;
  completeMessage?: string;
  failedMessage?: string;
}

@Injectable()
export class ProvisioningJobsService {
  private readonly jobs = new Map<string, ProvisioningJob>();
  private readonly listeners = new Map<string, Set<JobListener>>();

  constructor(private readonly redis: RedisService) {}

  start(
    user: any,
    meta: { serverId: string; nodeId?: string; kind?: string },
    task: (report: ProgressReporter) => Promise<any>,
    presentation: JobPresentation = {}
  ) {
    const now = new Date().toISOString();
    const job: ProvisioningJob = {
      id: randomUUID(),
      serverId: meta.serverId,
      nodeId: meta.nodeId,
      kind: meta.kind,
      requestedBy: String(user?.id || ''),
      status: 'queued',
      phase: 'queued',
      progress: 5,
      message: presentation.queuedMessage || 'Provisioning request queued',
      createdAt: now,
      updatedAt: now,
      history: [{
        phase: 'queued',
        progress: 5,
        message: presentation.queuedMessage || 'Provisioning request queued',
        at: now
      }]
    };
    this.jobs.set(job.id, job);
    void this.persist(job);

    setImmediate(() => void this.run(job.id, task, presentation));
    return this.publicJob(job);
  }

  async findForUser(id: string, user: any) {
    const job = this.jobs.get(id) || await this.redis.getJson<ProvisioningJob>(`provisioning:${id}`);
    if (!job) return undefined;
    const elevated = ['owner', 'admin'].includes(String(user?.role || ''));
    return elevated || job.requestedBy === String(user?.id || '') ? this.publicJob(job) : undefined;
  }

  async subscribe(id: string, user: any, listener: JobListener) {
    const job = await this.findForUser(id, user);
    if (!job) return undefined;
    const listeners = this.listeners.get(id) || new Set<JobListener>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    listener(job);
    const unsubscribeRedis = await this.redis.subscribe<ProvisioningJob>(`provisioning-events:${id}`, incoming => {
      this.jobs.set(id, incoming);
      listener(this.publicJob(incoming));
    });
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
      unsubscribeRedis();
    };
  }

  private async run(id: string, task: (report: ProgressReporter) => Promise<any>, presentation: JobPresentation) {
    const report: ProgressReporter = (phase, progress, message) => {
      this.update(id, { status: 'running', phase, progress: this.progress(progress), message });
    };
    let heartbeat: NodeJS.Timeout | undefined;

    try {
      report(
        presentation.startingPhase || 'validating',
        presentation.startingProgress ?? 15,
        presentation.startingMessage || 'Validating template and resource limits'
      );
      heartbeat = setInterval(() => {
        const current = this.jobs.get(id);
        if (current?.status === 'running') {
          this.update(id, {
            status: 'running',
            phase: current.phase,
            progress: current.progress,
            message: current.message
          });
        }
      }, 15_000);
      heartbeat.unref?.();
      const result = await task(report);
      this.update(id, {
        status: 'complete',
        phase: 'complete',
        progress: 100,
        message: presentation.completeMessage || 'Server is ready',
        result
      });
    } catch (error: any) {
      const message = error?.response?.errorMessage || error?.response?.message || error?.message || presentation.failedMessage || 'Provisioning failed';
      this.update(id, {
        status: 'failed',
        phase: 'failed',
        progress: 100,
        message: presentation.failedMessage || 'Provisioning failed',
        errorMessage: typeof message === 'string' ? message : JSON.stringify(message)
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      const cleanup = setTimeout(() => {
        this.jobs.delete(id);
        this.listeners.delete(id);
      }, 60 * 60 * 1000);
      cleanup.unref?.();
    }
  }

  private update(id: string, patch: Partial<ProvisioningJob>) {
    const current = this.jobs.get(id);
    if (!current) return;
    const updatedAt = new Date().toISOString();
    const history = [...(current.history || [])];
    if (
      patch.phase &&
      patch.message &&
      history[history.length - 1]?.phase !== patch.phase
    ) {
      history.push({
        phase: patch.phase,
        progress: this.progress(patch.progress ?? current.progress),
        message: patch.message,
        at: updatedAt
      });
    }
    const next = {
      ...current,
      ...patch,
      history: history.slice(-30),
      updatedAt
    };
    this.jobs.set(id, next);
    void this.persist(next);
    for (const listener of this.listeners.get(id) || []) listener(this.publicJob(next));
  }

  private async persist(job: ProvisioningJob) {
    await this.redis.setJson(`provisioning:${job.id}`, job, 3600);
    await this.redis.publish(`provisioning-events:${job.id}`, job);
  }

  private publicJob(job: ProvisioningJob): ProvisioningJob {
    const { requestedBy: _requestedBy, ...publicJob } = job;
    return publicJob as ProvisioningJob;
  }

  private progress(value: number) {
    return Math.min(99, Math.max(0, Math.round(Number(value) || 0)));
  }
}
