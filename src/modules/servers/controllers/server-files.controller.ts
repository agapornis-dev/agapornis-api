import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { AgentClientService } from '../../agent-client/agent-client.service';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import {
  downloadFileName,
  filePathFromBody,
} from '../utils/server-controller.helpers';
import { ServerRouteSupportService } from '../services/server-route-support.service';
import {
  CreateServerArchiveDto,
  CreateServerDirectoryDto,
  ExtractServerArchiveDto,
  MoveServerFilesDto,
  RenameServerFileDto,
  WriteServerFileDto,
} from '../dto/server-file.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('agents/:id/servers')
export class ServerFilesController {
  constructor(
    private readonly client: AgentClientService,
    private readonly support: ServerRouteSupportService,
  ) {}

  @Get(':serverId/files')
  @Roles('user')
  async listDirectory(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Query('path') pathQuery: string,
    @Query('targetPath') targetPathQuery: string,
    @Req() req: any,
  ) {
    const targetPath = this.support.queryPath(pathQuery, targetPathQuery, '/');

    await this.support.requireNodeServerPermission(id, serverId, req.user, 'files.view');

    return this.support.forward('list-directory', id, serverId, () =>
      this.client.listDirectory(id, serverId, targetPath),
    );
  }

  @Get(':serverId/files/content')
  @Roles('user')
  async readFile(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Query('path') pathQuery: string,
    @Query('targetPath') targetPathQuery: string,
    @Req() req: any,
  ) {
    const targetPath = this.support.queryPath(pathQuery, targetPathQuery);

    this.support.requirePath(targetPath);

    await this.support.requireNodeServerPermission(id, serverId, req.user, 'files.view');

    return this.support.forward('read-file', id, serverId, () =>
      this.client.readFileContent(id, serverId, targetPath),
      { mapError: error => this.support.fileReadError(error) },
    );
  }

  @Put(':serverId/files/content')
  @Roles('user')
  async writeFile(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: WriteServerFileDto,
    @Req() req: any,
  ) {
    const targetPath = filePathFromBody(body);

    this.support.requirePath(targetPath);
    this.support.requireNotSupport(req.user, 'write server files');

    await this.support.requireNodeServerPermission(id, serverId, req.user, 'files.write');

    const response = await this.support.forward('write-file', id, serverId, () =>
      this.client.writeFileContent(
        id,
        serverId,
        targetPath,
        String(body?.content ?? ''),
      ),
    );
    return this.support.publicActionResult(response);
  }

  @Post(':serverId/files/upload')
  @Roles('user')
  async uploadFile(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Query('path') pathQuery: string,
    @Query('targetPath') targetPathQuery: string,
    @Req() req: any,
  ) {
    const targetPath = this.support.queryPath(pathQuery, targetPathQuery);

    this.support.requirePath(targetPath);
    this.support.requireNotSupport(req.user, 'upload server files');

    await this.support.requireNodeServerPermission(id, serverId, req.user, 'files.write');

    const body = req.body;
    const upload = Buffer.isBuffer(body)
      ? (async function* () { yield body; })()
      : body && typeof body[Symbol.asyncIterator] === 'function'
        ? body
      : req.raw ?? req;

    const response = await this.support.forward('upload-file', id, serverId, () =>
      this.client.uploadFile(
        id,
        serverId,
        targetPath,
        upload,
      ),
    );
    return this.support.publicActionResult(response);
  }

  @Get(':serverId/files/download')
  @Roles('user')
  async downloadFile(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Query('path') pathQuery: string,
    @Query('targetPath') targetPathQuery: string,
    @Req() req: any,
    @Res() reply: FastifyReply,
  ) {
    const targetPath = this.support.queryPath(pathQuery, targetPathQuery);

    this.support.requirePath(targetPath);
    this.support.requireNotSupport(req.user, 'delete server files');

    await this.support.requireNodeServerPermission(id, serverId, req.user, 'files.view');

    const call = this.client.downloadFile(id, serverId, targetPath);
    const fileName = downloadFileName(targetPath).replace(/"/g, '');

    const res = reply.raw;

    let closed = false;
    let headersStarted = false;
    let paused = false;

    const canWrite = () => !closed && !res.destroyed && !res.writableEnded;

    const startDownloadHeaders = () => {
      if (headersStarted || res.headersSent) return;

      headersStarted = true;

      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      });
    };

    const endResponse = () => {
      if (closed) return;

      closed = true;

      if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    };

    const resumeDownload = () => {
      if (closed || !paused) return;
      paused = false;
      call.resume();
    };

    call.on('data', (message: any) => {
      const chunk = message.chunk_data || message.chunkData;

      if (!chunk) return;

      if (!headersStarted && !res.headersSent) {
        startDownloadHeaders();
      }

      if (!canWrite()) return;

      paused = !res.write(Buffer.from(chunk));
      if (paused) call.pause();
    });

    res.on('drain', resumeDownload);

    call.on('error', (error: any) => {
      if (!headersStarted && !res.headersSent) {
        closed = true;

        reply
          .code(HttpStatus.BAD_GATEWAY)
          .send(this.support.agentError('download-file', id, serverId, error));

        return;
      }

      endResponse();
    });

    call.on('end', () => {
      if (!headersStarted && !res.headersSent) {
        startDownloadHeaders();
      }

      endResponse();
    });

    res.on('close', () => {
      if (closed) return;

      closed = true;
      call.cancel();
    });
  }

  @Delete(':serverId/files')
  @Roles('user')
  async deleteFile(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Query('path') pathQuery: string,
    @Query('targetPath') targetPathQuery: string,
    @Req() req: any,
  ) {
    const targetPath = this.support.queryPath(pathQuery, targetPathQuery);

    this.support.requirePath(targetPath);

    await this.support.requireNodeServerPermission(id, serverId, req.user, 'files.write');

    const response = await this.support.forward('delete-file', id, serverId, () =>
      this.client.deleteFileOrDirectory(id, serverId, targetPath),
    );
    return this.support.publicActionResult(response);
  }

  @Post(':serverId/files/rename')
  @Roles('user')
  async renameFileOrDirectory(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: RenameServerFileDto,
    @Req() req: any,
  ) {
    const targetPath = filePathFromBody(body);
    const newName = String(body?.newName ?? body?.new_name ?? '').trim();
    this.support.requirePath(targetPath);
    if (!newName || newName === '.' || newName === '..' || /[\\/\0<>:"|?*\u0000-\u001f\u007f]/.test(newName)) {
      throw new HttpException('newName must be a single file or directory name', HttpStatus.BAD_REQUEST);
    }
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'files.write');
    const response = await this.support.forward('rename-file', id, serverId, () =>
      this.client.renameFileOrDirectory(id, serverId, targetPath, newName),
    );
    return this.support.publicActionResult(response);
  }

  @Post(':serverId/files/directory')
  @Roles('user')
  async createDirectory(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: CreateServerDirectoryDto,
    @Req() req: any,
  ) {
    const targetPath = filePathFromBody(body);
    this.support.requirePath(targetPath);
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'files.write');
    const response = await this.support.forward('create-directory', id, serverId, () =>
      this.client.createDirectory(id, serverId, targetPath),
    );
    return this.support.publicActionResult(response);
  }

  @Post(':serverId/files/move')
  @Roles('user')
  async moveFiles(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: MoveServerFilesDto,
    @Req() req: any,
  ) {
    const { sourcePaths, destinationPath } = this.fileSelection(body);
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'files.write');
    const response = await this.support.forward('move-files', id, serverId, () =>
      this.client.moveFiles(id, serverId, sourcePaths, destinationPath),
    );
    return this.support.publicActionResult(response);
  }

  @Post(':serverId/files/archive')
  @Roles('user')
  async createArchive(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: CreateServerArchiveDto,
    @Req() req: any,
  ) {
    const { sourcePaths, destinationPath } = this.fileSelection(body);
    if (!destinationPath.toLowerCase().endsWith('.tar.gz')) {
      throw new HttpException('archive destination must end with .tar.gz', HttpStatus.BAD_REQUEST);
    }
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'files.write');
    const response = await this.support.forward('create-archive', id, serverId, () =>
      this.client.createArchive(id, serverId, sourcePaths, destinationPath),
    );
    return this.support.publicActionResult(response);
  }

  @Post(':serverId/files/extract')
  @Roles('user')
  async extractArchive(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: ExtractServerArchiveDto,
    @Req() req: any,
  ) {
    const targetPath = filePathFromBody(body);
    const destinationPath = String(body?.destinationPath ?? body?.destination_path ?? '/');
    this.support.requirePath(targetPath);
    this.support.requirePath(destinationPath);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(targetPath) || /^[a-z][a-z0-9+.-]*:\/\//i.test(destinationPath)) {
      throw new HttpException('remote archive sources and destinations are not allowed', HttpStatus.BAD_REQUEST);
    }
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'files.write');
    const response = await this.support.forward('extract-archive', id, serverId, () =>
      this.client.extractArchive(id, serverId, targetPath, destinationPath),
    );
    return this.support.publicActionResult(response);
  }

  private fileSelection(body: MoveServerFilesDto) {
    const sourcePaths = body?.sourcePaths ?? body?.source_paths ?? [];
    const destinationPath = String(body?.destinationPath ?? body?.destination_path ?? '').trim();
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || sourcePaths.length > 100) {
      throw new HttpException('sourcePaths must contain between 1 and 100 paths', HttpStatus.BAD_REQUEST);
    }
    const normalizedSources = sourcePaths.map(value => String(value || '').trim());
    normalizedSources.forEach(value => this.support.requirePath(value));
    this.support.requirePath(destinationPath);
    if ([destinationPath, ...normalizedSources].some(value => /^[a-z][a-z0-9+.-]*:\/\//i.test(value))) {
      throw new HttpException('remote file paths are not allowed', HttpStatus.BAD_REQUEST);
    }
    return { sourcePaths: normalizedSources, destinationPath };
  }
}
