import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { Roles } from '../security/roles.decorator';
import { RolesGuard } from '../security/roles.guard';
import { TicketsService } from './tickets.service';
import { CreateTicketDto, ReplyTicketDto, UpdateTicketDto } from './dto/ticket.dto';

@Controller('tickets')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  list(@Req() req: any) {
    return this.tickets.list(req.user);
  }

  @Post()
  create(@Body() body: CreateTicketDto, @Req() req: any) {
    return this.tickets.create(body, req.user);
  }

  @Get('assignees')
  @Roles('support')
  assignees(@Req() req: any) {
    return this.tickets.assignees(req.user);
  }

  @Get(':id')
  find(@Param('id') id: string, @Req() req: any) {
    return this.tickets.find(id, req.user);
  }

  @Post(':id/messages')
  reply(@Param('id') id: string, @Body() body: ReplyTicketDto, @Req() req: any) {
    return this.tickets.reply(id, body, req.user);
  }

  @Patch(':id')
  @Roles('support')
  update(@Param('id') id: string, @Body() body: UpdateTicketDto, @Req() req: any) {
    return this.tickets.update(id, body, req.user);
  }

  @Post(':id/close')
  close(@Param('id') id: string, @Req() req: any) {
    return this.tickets.close(id, req.user);
  }


  @Post(':id/reopen')
  reopen(@Param('id') id: string, @Req() req: any) {
    return this.tickets.reopen(id, req.user);
  }
}
