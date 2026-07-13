import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import { MinecraftModsService, ModProjectType, ModProvider } from '../services/minecraft-mods.service';
import { ServerRouteSupportService } from '../services/server-route-support.service';
import { InstallServerModDto, RemoveServerModDto } from '../dto/server-mod.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('agents/:id/servers')
export class ServerModsController {
  constructor(
    private readonly mods: MinecraftModsService,
    private readonly support: ServerRouteSupportService,
  ) {}

  @Get(':serverId/mods/catalog')
  @Roles('user')
  async catalog(
    @Param('id') nodeId: string,
    @Param('serverId') serverId: string,
    @Query() query: any,
    @Req() req: any,
  ) {
    const server = await this.support.requireNodeServerPermission(nodeId, serverId, req.user, 'files.view');
    try {
      return await this.mods.search(server, {
        query: String(query?.query || '').slice(0, 120),
        provider: this.provider(query?.provider, true),
        projectType: this.projectType(query?.projectType || query?.type),
        gameVersion: this.optionalValue(query?.gameVersion),
        loader: this.optionalValue(query?.loader),
        page: this.integer(query?.page, 1, 1, 500),
        pageSize: this.integer(query?.pageSize, 20, 5, 50),
      });
    } catch (error: any) {
      throw new HttpException(error?.message || 'could not search mods', HttpStatus.BAD_REQUEST);
    }
  }

  @Get(':serverId/mods/installed')
  @Roles('user')
  async installed(@Param('id') nodeId: string, @Param('serverId') serverId: string, @Req() req: any) {
    const server = await this.support.requireNodeServerPermission(nodeId, serverId, req.user, 'files.view');
    try {
      return await this.mods.installed(server);
    } catch (error: any) {
      throw new HttpException(error?.message || 'could not list installed mods', HttpStatus.BAD_GATEWAY);
    }
  }

  @Post(':serverId/mods/install')
  @Roles('user')
  async install(
    @Param('id') nodeId: string,
    @Param('serverId') serverId: string,
    @Body() body: InstallServerModDto,
    @Req() req: any,
  ) {
    this.support.requireNotSupport(req.user, 'install Minecraft content');
    const server = await this.support.requireNodeServerPermission(nodeId, serverId, req.user, 'files.write');
    try {
      return await this.mods.install(server, {
        provider: this.provider(body?.provider, false) as ModProvider,
        projectId: String(body?.projectId || '').trim(),
        projectType: this.projectType(body?.projectType || body?.type),
        versionId: this.optionalValue(body?.versionId),
        gameVersion: this.optionalValue(body?.gameVersion),
        loader: this.optionalValue(body?.loader),
      });
    } catch (error: any) {
      throw new HttpException(error?.message || 'could not install project', HttpStatus.BAD_REQUEST);
    }
  }

  @Delete(':serverId/mods/installed')
  @Roles('user')
  async remove(
    @Param('id') nodeId: string,
    @Param('serverId') serverId: string,
    @Query('path') targetPath: string,
    @Body() body: RemoveServerModDto,
    @Req() req: any,
  ) {
    this.support.requireNotSupport(req.user, 'remove Minecraft mods');
    const server = await this.support.requireNodeServerPermission(nodeId, serverId, req.user, 'files.write');
    try {
      return await this.mods.remove(server, body?.fileName || body?.file_name || targetPath);
    } catch (error: any) {
      throw new HttpException(error?.message || 'could not remove mod', HttpStatus.BAD_REQUEST);
    }
  }

  private provider(value: unknown, allowAll: boolean): ModProvider | 'all' {
    const provider = String(value || (allowAll ? 'all' : '')).toLowerCase();
    if (provider === 'modrinth' || provider === 'curseforge' || (allowAll && provider === 'all')) return provider;
    throw new HttpException('provider must be modrinth, curseforge, or all', HttpStatus.BAD_REQUEST);
  }

  private projectType(value: unknown): ModProjectType {
    return String(value || 'mod').toLowerCase() === 'modpack' ? 'modpack' : 'mod';
  }

  private optionalValue(value: unknown) {
    const normalized = String(value || '').trim();
    if (!normalized) return undefined;
    if (!/^[a-zA-Z0-9._+ -]{1,80}$/.test(normalized)) throw new HttpException('invalid filter value', HttpStatus.BAD_REQUEST);
    return normalized;
  }

  private integer(value: unknown, fallback: number, minimum: number, maximum: number) {
    const parsed = Number(value || fallback);
    return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
  }
}
