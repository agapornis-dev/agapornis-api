import { Controller, Get, HttpException, HttpStatus, Param, Req, Res, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import { ProvisioningJobsService } from '../services/provisioning-jobs.service';
import type { FastifyReply } from 'fastify';


@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class ProvisioningController {
  constructor(private readonly jobs: ProvisioningJobsService) {}

  @Get(['provisioning/:id', 'operations/:id'])
  @Roles('user')
  async get(@Param('id') id: string, @Req() req: any) {
    const job = await this.jobs.findForUser(id, req.user);
    if (!job) throw new HttpException('provisioning job not found', HttpStatus.NOT_FOUND);
    return job;
  }

  @Get(['provisioning/:id/stream', 'operations/:id/stream'])
  @Roles('user')
  async stream(
    @Param('id') id: string,
    @Req() req: any,
    @Res() reply: FastifyReply,
  ) {
    const res = reply.raw;

    let closed = false;
    let unsubscribe: (() => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.flushHeaders?.();

    const cleanup = () => {
      if (closed) return;

      closed = true;

      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();

      if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    };

    unsubscribe = await this.jobs.subscribe(id, req.user, job => {
      if (closed || res.destroyed || res.writableEnded) return;

      const event =
        job.status === 'complete'
          ? 'complete'
          : job.status === 'failed'
            ? 'failed'
            : 'progress';

      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(job)}\n\n`);

      if (job.status === 'complete' || job.status === 'failed') {
        setTimeout(cleanup, 50);
      }
    });

    if (!unsubscribe) {
      cleanup();
      return;
    }

    heartbeat = setInterval(() => {
      if (!closed && !res.destroyed && !res.writableEnded) {
        res.write(': keep-alive\n\n');
      }
    }, 15_000);

    heartbeat.unref?.();

    res.on('close', cleanup);
  }
}
