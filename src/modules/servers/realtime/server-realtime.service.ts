import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { performance } from 'perf_hooks';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { ApiConfigService } from '../../../common/config/config.service';
import { ServerRegistryService } from '../services/server-registry.service';
import { ServerRouteSupportService } from '../services/server-route-support.service';

export interface RealtimeEvent {
  event: string;
  payload: any;
  terminal?: boolean;
}

type RealtimeListener = (message: RealtimeEvent) => void;

interface StatsFeed {
  nodeId: string;
  serverId: string;
  listeners: Map<number, RealtimeListener>;
  timer?: NodeJS.Timeout;
  stopTimer?: NodeJS.Timeout;
  requestAbort?: AbortController;
  polling: boolean;
  stopped: boolean;
  lastEvent?: RealtimeEvent;
  lastStatus?: string;
  diskLimitLoaded: boolean;
  hasPolled: boolean;
  diskLimitBytes?: number;
}

interface ConsoleFeed {
  nodeId: string;
  serverId: string;
  listeners: Set<RealtimeListener>;
  history: string[];
  call?: any;
  startTimer?: NodeJS.Timeout;
  retryTimer?: NodeJS.Timeout;
  flushTimer?: NodeJS.Timeout;
  pendingLines: string[];
  pendingReplayed?: boolean;
  pendingCharacters: number;
  historyCharacters: number;
  stopped: boolean;
}

@Injectable()
export class ServerRealtimeService implements OnModuleDestroy {
  private readonly statsFeeds = new Map<string, StatsFeed>();
  private readonly consoleFeeds = new Map<string, ConsoleFeed>();
  private readonly statsIntervalMs: number;
  private readonly statsStartDelayMs: number;
  private readonly consoleHistoryLimit: number;
  private readonly consoleHistoryCharacterLimit: number;
  private readonly consoleStartDelayMs: number;
  private readonly consoleBatchDelayMs: number;
  private readonly consoleBatchEntryLimit: number;
  private readonly consoleBatchCharacterLimit: number;
  private readonly statsDisconnectGraceMs: number;
  private nextStatsListenerId = 0;
  private readonly diagnosticsTimer: NodeJS.Timeout;
  private readonly processSamples: Array<{
    at: string;
    cpuPercent: number;
    eventLoopUtilizationPercent: number;
    rssBytes: number;
    heapUsedBytes: number;
  }> = [];
  private previousCpuUsage = process.cpuUsage();
  private previousCpuSampleAt = process.hrtime.bigint();
  private previousEventLoopUtilization = performance.eventLoopUtilization();
  private readonly counters = {
    browserStatsSubscriptions: 0,
    browserConsoleSubscriptions: 0,
    transientStatsSelections: 0,
    transientConsoleSelections: 0,
    statsPollsStarted: 0,
    statsPollsCancelled: 0,
    consoleStreamsStarted: 0,
    consoleMessagesReceived: 0,
    consoleBatchesBroadcast: 0
  };

  constructor(
    private readonly client: AgentClientService,
    private readonly registry: ServerRegistryService,
    private readonly support: ServerRouteSupportService,
    config: ApiConfigService,
  ) {
    this.statsIntervalMs = config.positiveInt('SERVER_STATS_STREAM_INTERVAL_MS', 1_000);
    this.statsStartDelayMs = Math.max(0, config.int('SERVER_STATS_STREAM_START_DELAY_MS', 75));
    this.consoleHistoryLimit = config.positiveInt('SERVER_CONSOLE_HISTORY_LIMIT', 500);
    this.consoleHistoryCharacterLimit = config.positiveInt('SERVER_CONSOLE_HISTORY_CHARACTER_LIMIT', 512 * 1024);
    this.consoleStartDelayMs = Math.max(0, config.int('SERVER_CONSOLE_STREAM_START_DELAY_MS', 25));
    this.consoleBatchDelayMs = Math.max(0, config.int('SERVER_CONSOLE_BATCH_DELAY_MS', 10));
    this.consoleBatchEntryLimit = config.positiveInt('SERVER_CONSOLE_BATCH_ENTRY_LIMIT', 16);
    this.consoleBatchCharacterLimit = config.positiveInt('SERVER_CONSOLE_BATCH_CHARACTER_LIMIT', 12 * 1024);
    this.statsDisconnectGraceMs = config.positiveInt('SERVER_STATS_DISCONNECT_GRACE_MS', 5_000);
    this.diagnosticsTimer = setInterval(() => this.sampleProcess(), 1_000);
    this.diagnosticsTimer.unref?.();
  }

  subscribeStats(nodeId: string, serverId: string, listener: RealtimeListener) {
    this.counters.browserStatsSubscriptions += 1;
    const key = this.key(nodeId, serverId);
    let feed = this.statsFeeds.get(key);

    if (!feed) {
      feed = {
        nodeId,
        serverId,
        listeners: new Map(),
        polling: false,
        stopped: false,
        diskLimitLoaded: false,
        hasPolled: false
      };
      this.statsFeeds.set(key, feed);
    }

    if (feed.stopTimer) clearTimeout(feed.stopTimer);
    feed.stopTimer = undefined;
    const listenerId = ++this.nextStatsListenerId;
    feed.listeners.set(listenerId, listener);
    if (feed.lastEvent) listener(feed.lastEvent);
    if (!feed.timer && !feed.polling) this.scheduleStatsPoll(key, feed, this.statsStartDelayMs);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      feed!.listeners.delete(listenerId);
      if (feed!.listeners.size === 0) {
        if (!feed!.hasPolled && feed!.timer) this.counters.transientStatsSelections += 1;
        this.scheduleStatsFeedStop(key, feed!);
      }
    };
  }

  subscribeConsole(nodeId: string, serverId: string, listener: RealtimeListener) {
    this.counters.browserConsoleSubscriptions += 1;
    const key = this.key(nodeId, serverId);
    let feed = this.consoleFeeds.get(key);

    if (!feed) {
      feed = {
        nodeId,
        serverId,
        listeners: new Set(),
        history: [],
        pendingLines: [],
        pendingCharacters: 0,
        historyCharacters: 0,
        stopped: false
      };
      this.consoleFeeds.set(key, feed);
    }

    feed.listeners.add(listener);
    this.replayConsoleHistory(feed, listener);
    if (!feed.call && !feed.startTimer) this.scheduleConsoleStart(key, feed);

    return () => {
      feed!.listeners.delete(listener);
      if (feed!.listeners.size === 0) {
        if (!feed!.call && feed!.startTimer) this.counters.transientConsoleSelections += 1;
        this.stopConsoleFeed(key, feed!);
      }
    };
  }

  onModuleDestroy() {
    clearInterval(this.diagnosticsTimer);
    for (const [key, feed] of this.statsFeeds) this.stopStatsFeed(key, feed);
    for (const [key, feed] of this.consoleFeeds) this.stopConsoleFeed(key, feed);
  }

  private async pollStats(key: string, feed: StatsFeed) {
    if (!this.isCurrentStatsFeed(key, feed)) return;
    const pollStartedAt = performance.now();
    feed.polling = true;
    feed.hasPolled = true;
    this.counters.statsPollsStarted += 1;
    const requestAbort = new AbortController();
    feed.requestAbort = requestAbort;

    try {
      const data: any = await this.client.getServerStats(
        feed.nodeId,
        feed.serverId,
        undefined,
        requestAbort.signal);
      await this.applyStatsMetadata(feed, data);
      const message: RealtimeEvent = {
        event: 'stats',
        payload: { type: 'stats', nodeId: feed.nodeId, serverId: feed.serverId, data }
      };
      feed.lastEvent = message;
      this.broadcast(feed.listeners.values(), message);
    } catch (error: any) {
      if (requestAbort.signal.aborted) this.counters.statsPollsCancelled += 1;
      if (!requestAbort.signal.aborted) this.broadcast(feed.listeners.values(), {
        event: 'stats-error',
        payload: {
          type: 'error',
          nodeId: feed.nodeId,
          serverId: feed.serverId,
          errorMessage: 'stats unavailable'
        }
      });
    } finally {
      if (feed.requestAbort === requestAbort) feed.requestAbort = undefined;
      feed.polling = false;
      if (this.isCurrentStatsFeed(key, feed) && feed.listeners.size > 0) {
        const elapsedMs = performance.now() - pollStartedAt;
        this.scheduleStatsPoll(
          key,
          feed,
          requestAbort.signal.aborted
            ? 0
            : Math.max(0, this.statsIntervalMs - elapsedMs));
      }
    }
  }

  private async applyStatsMetadata(feed: StatsFeed, data: any) {
    const reportedDiskLimit = Number(data?.disk_limit_bytes || data?.diskLimitBytes || 0);
    if (reportedDiskLimit > 0) {
      feed.diskLimitBytes = reportedDiskLimit;
      feed.diskLimitLoaded = true;
    } else {
      if (!feed.diskLimitLoaded) {
        const record = await this.registry.get(feed.serverId);
        feed.diskLimitBytes = Number(record?.diskLimitBytes || 0) || undefined;
        feed.diskLimitLoaded = true;
      }
      if (feed.diskLimitBytes) {
        data.disk_limit_bytes = feed.diskLimitBytes;
        data.diskLimitBytes = feed.diskLimitBytes;
      }
    }

    const status = String(data?.status || '');
    if (status) {
      const effectiveStatus = await this.support.recordObservedStatus(
        feed.nodeId,
        feed.serverId,
        status
      );
      data.status = effectiveStatus || status;
      feed.lastStatus = data.status;
    }
  }

  private startConsoleFeed(key: string, feed: ConsoleFeed) {
    if (!this.isCurrentConsoleFeed(key, feed) || feed.listeners.size === 0) return;
    feed.startTimer = undefined;
    this.counters.consoleStreamsStarted += 1;
    if (feed.retryTimer) clearTimeout(feed.retryTimer);
    feed.retryTimer = undefined;

    let call: any;
    try {
      call = this.client.streamConsole(feed.nodeId, feed.serverId);
    } catch (error: any) {
      this.broadcast(feed.listeners, {
        event: 'agent-error',
        payload: {
          nodeId: feed.nodeId,
          serverId: feed.serverId,
          errorMessage: 'console unavailable; reconnecting'
        }
      });
      this.scheduleConsoleReconnect(key, feed);
      return;
    }
    feed.call = call;

    call.on('data', (message: any) => {
      if (!this.isCurrentConsoleFeed(key, feed) || feed.call !== call) return;
      const line = message.log_line || message.logLine || '';
      if (!line) return;
      this.counters.consoleMessagesReceived += 1;
      // Proto3 optional presence distinguishes upgraded agents from legacy
      // agents. Legacy output is treated as replay to avoid false live-only
      // alerts while nodes are rolling forward.
      const replayed = message._replayed === 'replayed' ? Boolean(message.replayed) : true;
      this.queueConsoleLine(feed, line, replayed);
    });

    call.on('error', (error: any) => {
      if (!this.isCurrentConsoleFeed(key, feed) || feed.call !== call) return;
      this.flushConsole(feed);
      this.broadcast(feed.listeners, {
        event: 'agent-error',
        payload: {
          nodeId: feed.nodeId,
          serverId: feed.serverId,
          errorMessage: 'console unavailable; reconnecting'
        }
      });
      feed.call = undefined;
      this.scheduleConsoleReconnect(key, feed);
    });

    call.on('end', () => {
      if (!this.isCurrentConsoleFeed(key, feed) || feed.call !== call) return;
      this.flushConsole(feed);
      this.broadcast(feed.listeners, {
        event: 'agent-action',
        payload: { action: 'console-reconnecting', nodeId: feed.nodeId, serverId: feed.serverId }
      });
      feed.call = undefined;
      this.scheduleConsoleReconnect(key, feed);
    });
  }

  private stopStatsFeed(key: string, feed: StatsFeed) {
    if (!this.isCurrentStatsFeed(key, feed)) return;
    feed.stopped = true;
    if (feed.timer) clearTimeout(feed.timer);
    if (feed.stopTimer) clearTimeout(feed.stopTimer);
    feed.timer = undefined;
    feed.stopTimer = undefined;
    feed.requestAbort?.abort();
    feed.requestAbort = undefined;
    feed.polling = false;
    feed.listeners.clear();
    this.statsFeeds.delete(key);
  }

  private stopConsoleFeed(key: string, feed: ConsoleFeed) {
    if (!this.isCurrentConsoleFeed(key, feed)) return;
    feed.stopped = true;
    this.consoleFeeds.delete(key);
    feed.listeners.clear();
    if (feed.startTimer) clearTimeout(feed.startTimer);
    if (feed.retryTimer) clearTimeout(feed.retryTimer);
    if (feed.flushTimer) clearTimeout(feed.flushTimer);
    feed.startTimer = undefined;
    feed.retryTimer = undefined;
    feed.flushTimer = undefined;
    feed.pendingLines.length = 0;
    feed.pendingCharacters = 0;
    const call = feed.call;
    feed.call = undefined;
    call?.cancel?.();
  }

  private scheduleConsoleReconnect(key: string, feed: ConsoleFeed) {
    if (!this.isCurrentConsoleFeed(key, feed) || feed.listeners.size === 0 || feed.retryTimer) return;
    feed.retryTimer = setTimeout(() => {
      feed.retryTimer = undefined;
      this.startConsoleFeed(key, feed);
    }, 1_000);
    feed.retryTimer.unref?.();
  }

  private scheduleStatsPoll(key: string, feed: StatsFeed, delayMs: number) {
    if (!this.isCurrentStatsFeed(key, feed) || feed.listeners.size === 0 || feed.timer || feed.polling) return;
    feed.timer = setTimeout(() => {
      feed.timer = undefined;
      void this.pollStats(key, feed);
    }, delayMs);
    feed.timer.unref?.();
  }

  private scheduleConsoleStart(key: string, feed: ConsoleFeed) {
    if (!this.isCurrentConsoleFeed(key, feed) || feed.listeners.size === 0 || feed.call || feed.startTimer) return;
    feed.startTimer = setTimeout(() => {
      feed.startTimer = undefined;
      this.startConsoleFeed(key, feed);
    }, this.consoleStartDelayMs);
    feed.startTimer.unref?.();
  }

  private queueConsoleLine(feed: ConsoleFeed, line: string, replayed: boolean) {
    if (feed.pendingLines.length > 0 && feed.pendingReplayed !== replayed) this.flushConsole(feed);
    feed.pendingReplayed = replayed;
    feed.pendingLines.push(line);
    feed.pendingCharacters += line.length + 1;
    if (feed.pendingLines.length >= this.consoleBatchEntryLimit ||
        feed.pendingCharacters >= this.consoleBatchCharacterLimit) {
      this.flushConsole(feed);
      return;
    }
    if (feed.flushTimer) return;
    feed.flushTimer = setTimeout(() => {
      feed.flushTimer = undefined;
      this.flushConsole(feed);
    }, this.consoleBatchDelayMs);
    feed.flushTimer.unref?.();
  }

  private flushConsole(feed: ConsoleFeed) {
    if (feed.flushTimer) clearTimeout(feed.flushTimer);
    feed.flushTimer = undefined;
    if (feed.pendingLines.length === 0) return;
    const line = feed.pendingLines.join('\n');
    const replayed = Boolean(feed.pendingReplayed);
    feed.pendingLines.length = 0;
    feed.pendingCharacters = 0;
    feed.pendingReplayed = undefined;

    feed.history.push(line);
    feed.historyCharacters += line.length;
    while (feed.history.length > this.consoleHistoryLimit ||
           feed.historyCharacters > this.consoleHistoryCharacterLimit) {
      const removed = feed.history.shift();
      if (removed) feed.historyCharacters -= removed.length;
    }
    this.broadcast(feed.listeners, {
      event: 'console',
      payload: { nodeId: feed.nodeId, serverId: feed.serverId, line, replayed }
    });
    this.counters.consoleBatchesBroadcast += 1;
  }

  private replayConsoleHistory(feed: ConsoleFeed, listener: RealtimeListener) {
    let batch: string[] = [];
    let characters = 0;
    const flush = () => {
      if (batch.length === 0) return;
      listener({
        event: 'console',
        payload: { nodeId: feed.nodeId, serverId: feed.serverId, line: batch.join('\n'), replayed: true }
      });
      batch = [];
      characters = 0;
    };
    for (const entry of feed.history) {
      if (batch.length > 0 &&
          (batch.length >= this.consoleBatchEntryLimit ||
           characters + entry.length + 1 > this.consoleBatchCharacterLimit)) flush();
      batch.push(entry);
      characters += entry.length + 1;
    }
    flush();
  }

  diagnostics() {
    const samples = [...this.processSamples];
    const latest = samples[samples.length - 1];
    return {
      sampledAt: new Date().toISOString(),
      process: {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        latest,
        maxCpuPercent: samples.length ? Math.max(...samples.map(sample => sample.cpuPercent)) : 0,
        maxEventLoopUtilizationPercent: samples.length
          ? Math.max(...samples.map(sample => sample.eventLoopUtilizationPercent))
          : 0,
        samples
      },
      realtime: {
        activeStatsFeeds: this.statsFeeds.size,
        activeStatsListeners: Array.from(this.statsFeeds.values())
          .reduce((total, feed) => total + feed.listeners.size, 0),
        activeConsoleFeeds: this.consoleFeeds.size,
        activeConsoleListeners: Array.from(this.consoleFeeds.values())
          .reduce((total, feed) => total + feed.listeners.size, 0),
        counters: { ...this.counters }
      }
    };
  }

  private sampleProcess() {
    const sampledAt = process.hrtime.bigint();
    const cpuUsage = process.cpuUsage();
    const elapsedMicroseconds = Number(sampledAt - this.previousCpuSampleAt) / 1_000;
    const usedMicroseconds =
      cpuUsage.user - this.previousCpuUsage.user +
      cpuUsage.system - this.previousCpuUsage.system;
    const eventLoop = performance.eventLoopUtilization(this.previousEventLoopUtilization);
    const memory = process.memoryUsage();
    this.previousCpuUsage = cpuUsage;
    this.previousCpuSampleAt = sampledAt;
    this.previousEventLoopUtilization = performance.eventLoopUtilization();
    this.processSamples.push({
      at: new Date().toISOString(),
      cpuPercent: elapsedMicroseconds > 0 ? usedMicroseconds / elapsedMicroseconds * 100 : 0,
      eventLoopUtilizationPercent: eventLoop.utilization * 100,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed
    });
    if (this.processSamples.length > 60) this.processSamples.splice(0, this.processSamples.length - 60);
  }

  private scheduleStatsFeedStop(key: string, feed: StatsFeed) {
    if (!this.isCurrentStatsFeed(key, feed) || feed.listeners.size > 0 || feed.stopTimer) return;
    // Keep the last sample briefly for a fast return, but stop agent work as soon
    // as the final browser leaves this server.
    if (feed.timer) clearTimeout(feed.timer);
    feed.timer = undefined;
    feed.requestAbort?.abort();
    feed.stopTimer = setTimeout(() => {
      feed.stopTimer = undefined;
      if (feed.listeners.size === 0) this.stopStatsFeed(key, feed);
    }, this.statsDisconnectGraceMs);
    feed.stopTimer.unref?.();
  }

  private broadcast(listeners: Iterable<RealtimeListener>, message: RealtimeEvent) {
    for (const listener of [...listeners]) {
      try {
        listener(message);
      } catch {
        // A response can disappear between its writable check and write call.
        // Its close handler owns unsubscription and feed cleanup.
      }
    }
  }

  private isCurrentStatsFeed(key: string, feed: StatsFeed) {
    return !feed.stopped && this.statsFeeds.get(key) === feed;
  }

  private isCurrentConsoleFeed(key: string, feed: ConsoleFeed) {
    return !feed.stopped && this.consoleFeeds.get(key) === feed;
  }

  private key(nodeId: string, serverId: string) {
    return `${nodeId}\u0000${serverId}`;
  }

  private positiveNumber(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
  }

  private nonNegativeNumber(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
  }
}
