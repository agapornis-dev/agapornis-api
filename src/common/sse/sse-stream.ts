import type { FastifyReply } from 'fastify';

export type Unsubscribe = () => void;

export interface SseStreamOptions<T> {
  reply: FastifyReply;
  event?: string;
  heartbeatMs?: number;
  subscribe: (publish: (data: T, event?: string) => void) => Unsubscribe;
}

export function openSseStream<T>(options: SseStreamOptions<T>) {
  const res = options.reply.raw;
  let closed = false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.flushHeaders?.();

  const publish = (data: T, event = options.event || 'snapshot') => {
    if (closed || res.destroyed || res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const unsubscribe = options.subscribe(publish);
  const heartbeat = setInterval(() => {
    if (!closed && !res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
  }, options.heartbeatMs || 15_000);

  heartbeat.unref?.();

  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  });
}
