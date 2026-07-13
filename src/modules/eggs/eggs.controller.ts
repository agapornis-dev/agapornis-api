import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { EggsService } from './eggs.service';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RolesGuard } from '../security/roles.guard';
import { Roles } from '../security/roles.decorator';
import { AssignEggNestDto, CreateEggNestDto, ImportEggBatchDto, ImportEggDto, UpdateEggNestDto } from './dto/egg.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('eggs')
export class EggsController {
  constructor(private readonly eggs: EggsService) {}

  @Get()
  @Roles('admin')
  list(@Req() req: any) {
    return this.eggs.clientList(req.user.role);
  }

  @Get('nests')
  @Roles('admin')
  nests() {
    return this.eggs.listNests();
  }

  @Post('nests')
  @Roles('owner', 'admin')
  createNest(@Body() body: CreateEggNestDto) {
    try {
      return this.eggs.createNest(body);
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Patch('nests/:id')
  @Roles('owner', 'admin')
  updateNest(@Param('id') id: string, @Body() body: UpdateEggNestDto) {
    try {
      return this.eggs.updateNest(id, body);
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Delete('nests/:id')
  @Roles('owner', 'admin')
  removeNest(@Param('id') id: string) {
    try {
      return this.eggs.removeNest(id);
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Patch(':id/nest')
  @Roles('owner', 'admin')
  assignNest(@Param('id') id: string, @Body() body: AssignEggNestDto) {
    try {
      return this.eggs.assignNest(id, String(body?.nestId || body?.nest_id || ''));
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Get('catalog')
  @Roles('admin')
  catalog() {
    return this.eggs.catalog().map(item => ({
      id: item.id,
      eggId: item.eggId,
      name: item.name,
      description: item.description,
      category: item.category,
      installed: item.installed
    }));
  }

  @Post('catalog/:catalogId/install')
  @Roles('owner', 'admin')
  async installCatalog(@Param('catalogId') catalogId: string) {
    try {
      return await this.eggs.installCatalog(catalogId);
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Get(':id')
  @Roles('admin')
  get(@Param('id') id: string, @Req() req: any) {
    try {
      return this.eggs.clientEgg(id, req.user.role);
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.NOT_FOUND);
    }
  }

  @Post('import')
  @Roles('owner', 'admin')
  import(@Body() body: ImportEggDto) {
    try {
      const egg = this.eggs.import(body);
      return { id: egg.id, name: egg.name, imported: true };
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Post('import/batch')
  @Roles('owner', 'admin')
  importBatch(@Body() body: ImportEggBatchDto | ImportEggDto[]) {
    try {
      const eggs = this.eggs.importMany(Array.isArray(body) ? body : body?.eggs);
      return { imported: eggs.length };
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Delete(':id')
  @Roles('owner', 'admin')
  remove(@Param('id') id: string) {
    try {
      return this.eggs.remove(id);
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.NOT_FOUND);
    }
  }
}
