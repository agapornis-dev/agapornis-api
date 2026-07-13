import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DatabaseService } from '../database/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../settings/mail.service';
import { PanelSettingsService } from '../settings/panel-settings.service';
import { UsersService } from '../users/users.service';

export type TicketCategory = 'general' | 'technical' | 'billing' | 'abuse';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TicketStatus = 'open' | 'waiting_on_staff' | 'waiting_on_user' | 'resolved' | 'closed';

export interface TicketActor {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface TicketMessage {
  id: string;
  authorUserId: string;
  authorName: string;
  authorRole: string;
  body: string;
  internal?: boolean;
  createdAt: string;
}

export interface SupportTicket {
  id: string;
  userId: string;
  requesterName: string;
  requesterEmail: string;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  assignedUserId?: string;
  messages: TicketMessage[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

@Injectable()
export class TicketsService implements OnModuleInit {
  private readonly logger = new Logger(TicketsService.name);
  private readonly tickets = new Map<string, SupportTicket>();
  private readonly dataFile = path.join(__dirname, '..', '..', 'data', 'support-tickets.json');

  constructor(
    private readonly database: DatabaseService,
    private readonly activityLog: ActivityLogService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
    private readonly settings: PanelSettingsService,
    private readonly mail: MailService
  ) {
    this.load();
  }

  async onModuleInit() {
    if (!this.database.enabled) return;
    const records = await this.database.hydrateCollection('support-tickets', Array.from(this.tickets.values()), ticket => ticket.id);
    this.tickets.clear();
    for (const ticket of records) this.tickets.set(ticket.id, this.normalizeStoredTicket(ticket));
  }

  list(actor: TicketActor) {
    this.settings.enforceTicketSupport();
    return Array.from(this.tickets.values())
      .filter(ticket => this.isStaff(actor) || ticket.userId === actor.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(ticket => this.copy(ticket, actor));
  }

  find(ticketId: string, actor: TicketActor) {
    this.settings.enforceTicketSupport();
    const ticket = this.ticket(ticketId);
    this.assertCanView(ticket, actor);
    return this.copy(ticket, actor);
  }

  assignees(actor: TicketActor) {
    this.settings.enforceTicketSupport();
    if (!this.isStaff(actor)) throw new ForbiddenException('support role required');
    return this.staffUsers().map(user => ({ id: user.id, name: user.name, email: user.email, role: user.role }));
  }

  create(input: any, actor: TicketActor) {
    this.settings.enforceTicketSupport();
    const subject = this.requiredText(input?.subject, 'subject', 180);
    const body = this.requiredText(input?.message ?? input?.body, 'message', 8000);
    const now = new Date().toISOString();
    const ticket: SupportTicket = {
      id: this.ticketId(),
      userId: actor.id,
      requesterName: actor.name,
      requesterEmail: actor.email,
      subject,
      category: this.category(input?.category),
      priority: this.priority(input?.priority),
      status: 'waiting_on_staff',
      messages: [this.message(body, actor, now)],
      createdAt: now,
      updatedAt: now
    };

    this.tickets.set(ticket.id, ticket);
    this.save();
    this.activityLog.log({ event: 'ticket.created', userId: actor.id, userName: actor.name, meta: { ticketId: ticket.id, category: ticket.category, priority: ticket.priority } });
    this.notifyStaff(ticket, actor, 'ticket_created', `New ${ticket.category} ticket from ${ticket.requesterName}`, ticket.subject);
    this.sendTicketMail('ticketCreated', ticket.requesterEmail, ticket, actor);
    this.mailStaff(ticket, actor);
    return this.copy(ticket, actor);
  }

  reply(ticketId: string, input: any, actor: TicketActor) {
    this.settings.enforceTicketSupport();
    const ticket = this.ticket(ticketId);
    this.assertCanView(ticket, actor);
    if (ticket.status === 'closed') throw new BadRequestException('closed tickets cannot receive replies');

    const internal = input?.internal === true;
    if (internal && !this.isStaff(actor)) throw new ForbiddenException('support role required for internal notes');
    const body = this.requiredText(input?.message ?? input?.body, 'message', 8000);
    const now = new Date().toISOString();
    ticket.messages.push(this.message(body, actor, now, internal));
    ticket.updatedAt = now;
    if (!internal) ticket.status = this.isStaff(actor) ? 'waiting_on_user' : 'waiting_on_staff';
    delete ticket.closedAt;
    this.save();
    this.activityLog.log({ event: internal ? 'ticket.note_added' : 'ticket.replied', userId: actor.id, userName: actor.name, meta: { ticketId: ticket.id, status: ticket.status } });
    if (internal) {
      // Internal notes deliberately remain in the staff queue and never notify the requester.
    } else if (this.isStaff(actor)) {
      this.notifyRequester(ticket, actor, 'ticket_reply', `Support replied to ${ticket.id}`, `${actor.name} replied to “${ticket.subject}”.`);
      this.sendTicketMail('ticketReply', ticket.requesterEmail, ticket, actor, body);
    } else {
      this.notifyStaff(ticket, actor, 'ticket_reply', `${ticket.requesterName} replied to ${ticket.id}`, ticket.subject);
      this.mailStaff(ticket, actor, body);
    }
    return this.copy(ticket, actor);
  }

  update(ticketId: string, input: any, actor: TicketActor) {
    this.settings.enforceTicketSupport();
    if (!this.isStaff(actor)) throw new ForbiddenException('support role required');
    const ticket = this.ticket(ticketId);
    const previousStatus = ticket.status;
    const previousAssignee = ticket.assignedUserId;
    if (input?.status !== undefined) ticket.status = this.status(input.status);
    if (input?.priority !== undefined) ticket.priority = this.priority(input.priority);
    if (input?.assignedUserId !== undefined) ticket.assignedUserId = this.assignee(input.assignedUserId);
    ticket.updatedAt = new Date().toISOString();
    if (ticket.status === 'closed') ticket.closedAt = ticket.updatedAt;
    else delete ticket.closedAt;
    this.save();
    this.activityLog.log({ event: 'ticket.updated', userId: actor.id, userName: actor.name, meta: { ticketId: ticket.id, status: ticket.status, priority: ticket.priority } });
    if (previousStatus !== ticket.status) {
      this.notifyRequester(ticket, actor, 'ticket_status', `${ticket.id} is now ${ticket.status.replace(/_/g, ' ')}`, ticket.subject);
      this.sendTicketMail('ticketStatus', ticket.requesterEmail, ticket, actor);
    }
    if (ticket.assignedUserId && ticket.assignedUserId !== previousAssignee && ticket.assignedUserId !== actor.id) {
      const assigned = this.users.findById(ticket.assignedUserId);
      if (assigned) {
        this.notifications.create({
          recipientUserId: assigned.id,
          type: 'ticket_status',
          title: `${ticket.id} was assigned to you`,
          message: ticket.subject,
          href: this.ticketHref(ticket.id),
          resourceId: ticket.id,
          actorUserId: actor.id
        });
        this.sendTicketMail('ticketStaffNotification', assigned.email, ticket, actor, `Assigned to ${assigned.name}`);
      }
    }
    return this.copy(ticket, actor);
  }

  close(ticketId: string, actor: TicketActor) {
    this.settings.enforceTicketSupport();
    const ticket = this.ticket(ticketId);
    this.assertCanView(ticket, actor);
    ticket.status = 'closed';
    ticket.closedAt = new Date().toISOString();
    ticket.updatedAt = ticket.closedAt;
    this.save();
    this.activityLog.log({ event: 'ticket.closed', userId: actor.id, userName: actor.name, meta: { ticketId: ticket.id } });
    this.notifyRequester(ticket, actor, 'ticket_status', `${ticket.id} was closed`, ticket.subject);
    if (ticket.userId !== actor.id) this.sendTicketMail('ticketStatus', ticket.requesterEmail, ticket, actor);
    return this.copy(ticket, actor);
  }

  reopen(ticketId: string, actor: TicketActor) {
    this.settings.enforceTicketSupport();
    const ticket = this.ticket(ticketId);
    this.assertCanView(ticket, actor);
    if (ticket.status !== 'closed' && ticket.status !== 'resolved') throw new BadRequestException('ticket is already active');
    ticket.status = 'waiting_on_staff';
    ticket.updatedAt = new Date().toISOString();
    delete ticket.closedAt;
    this.save();
    this.activityLog.log({ event: 'ticket.reopened', userId: actor.id, userName: actor.name, meta: { ticketId: ticket.id } });
    if (this.isStaff(actor)) {
      this.notifyRequester(ticket, actor, 'ticket_status', `${ticket.id} was reopened`, ticket.subject);
      this.sendTicketMail('ticketStatus', ticket.requesterEmail, ticket, actor);
    } else {
      this.notifyStaff(ticket, actor, 'ticket_reply', `${ticket.requesterName} reopened ${ticket.id}`, ticket.subject);
      this.mailStaff(ticket, actor, 'Ticket reopened by requester');
    }
    return this.copy(ticket, actor);
  }

  private notifyStaff(ticket: SupportTicket, actor: TicketActor, type: 'ticket_created' | 'ticket_reply', title: string, message: string) {
    if (!this.settings.ticketNotificationsEnabled()) return;
    const staffIds = this.staffUsers()
      .filter(user => user.id !== actor.id)
      .map(user => user.id);
    this.notifications.createForUsers(staffIds, {
      type,
      title,
      message,
      href: this.ticketHref(ticket.id),
      resourceId: ticket.id,
      actorUserId: actor.id
    });
  }

  private notifyRequester(ticket: SupportTicket, actor: TicketActor, type: 'ticket_reply' | 'ticket_status', title: string, message: string) {
    if (!this.settings.ticketNotificationsEnabled() || ticket.userId === actor.id) return;
    this.notifications.create({
      recipientUserId: ticket.userId,
      type,
      title,
      message,
      href: this.ticketHref(ticket.id),
      resourceId: ticket.id,
      actorUserId: actor.id
    });
  }

  private ticket(ticketId: string) {
    const ticket = this.tickets.get(String(ticketId || '').trim().toUpperCase());
    if (!ticket) throw new NotFoundException('ticket not found');
    return ticket;
  }

  private assertCanView(ticket: SupportTicket, actor: TicketActor) {
    if (!this.isStaff(actor) && ticket.userId !== actor.id) throw new ForbiddenException('ticket access denied');
  }

  private isStaff(actor: TicketActor) {
    return ['support', 'admin', 'owner'].includes(actor.role);
  }

  private message(body: string, actor: TicketActor, createdAt: string, internal = false): TicketMessage {
    return {
      id: crypto.randomUUID(),
      authorUserId: actor.id,
      authorName: actor.name,
      authorRole: actor.role,
      body,
      internal: internal || undefined,
      createdAt
    };
  }

  private ticketId() {
    let id = '';
    do id = `TKT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    while (this.tickets.has(id));
    return id;
  }

  private requiredText(value: unknown, name: string, maxLength: number) {
    const text = String(value || '').trim();
    if (!text) throw new BadRequestException(`${name} is required`);
    if (text.length > maxLength) throw new BadRequestException(`${name} must be ${maxLength} characters or fewer`);
    return text;
  }

  private category(value: unknown): TicketCategory {
    return value === 'technical' || value === 'billing' || value === 'abuse' || value === 'general' ? value : 'general';
  }

  private priority(value: unknown): TicketPriority {
    return value === 'low' || value === 'high' || value === 'urgent' || value === 'normal' ? value : 'normal';
  }

  private status(value: unknown): TicketStatus {
    if (value === 'open' || value === 'waiting_on_staff' || value === 'waiting_on_user' || value === 'resolved' || value === 'closed') return value;
    throw new BadRequestException('invalid ticket status');
  }

  private assignee(value: unknown) {
    if (value === null || value === '') return undefined;
    const user = this.users.findById(String(value || ''));
    if (!user || !['support', 'admin', 'owner'].includes(user.role)) throw new BadRequestException('assignee must be a support staff member');
    return user.id;
  }

  private staffUsers() {
    return this.users.list().filter(user => ['support', 'admin', 'owner'].includes(user.role));
  }

  private ticketHref(ticketId: string) {
    return `/?screen=tickets&ticket=${encodeURIComponent(ticketId)}`;
  }

  private ticketUrl(ticketId: string) {
    const base = String(this.settings.publicSettings().branding.publicUrl || '').replace(/\/$/, '');
    return base ? `${base}${this.ticketHref(ticketId)}` : '';
  }

  private mailStaff(ticket: SupportTicket, actor: TicketActor, excerpt = ticket.messages[ticket.messages.length - 1]?.body || '') {
    if (!this.settings.ticketNotificationsEnabled()) return;
    for (const staff of this.staffUsers()) {
      if (staff.id === actor.id) continue;
      this.sendTicketMail('ticketStaffNotification', staff.email, ticket, actor, excerpt);
    }
  }

  private sendTicketMail(template: 'ticketCreated' | 'ticketStaffNotification' | 'ticketReply' | 'ticketStatus', recipient: string, ticket: SupportTicket, actor: TicketActor, excerpt = '') {
    if (!this.settings.ticketNotificationsEnabled()) return;
    void this.mail.send(template, recipient, {
      'user.name': recipient === ticket.requesterEmail ? ticket.requesterName : (this.users.findByEmail(recipient)?.name || recipient),
      'actor.name': actor.name,
      'ticket.id': ticket.id,
      'ticket.subject': ticket.subject,
      'ticket.category': ticket.category,
      'ticket.priority': ticket.priority,
      'ticket.status': ticket.status.replace(/_/g, ' '),
      'ticket.excerpt': excerpt.slice(0, 500),
      'ticket.url': this.ticketUrl(ticket.id)
    });
  }

  private normalizeStoredTicket(ticket: SupportTicket): SupportTicket {
    return {
      ...ticket,
      category: this.category(ticket.category),
      priority: this.priority(ticket.priority),
      status: this.status(ticket.status),
      messages: Array.isArray(ticket.messages) ? ticket.messages : []
    };
  }

  private copy(ticket: SupportTicket, actor: TicketActor) {
    const staff = this.isStaff(actor);
    return {
      id: ticket.id,
      requesterName: staff ? ticket.requesterName : undefined,
      requesterEmail: staff ? ticket.requesterEmail : undefined,
      subject: ticket.subject,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      assignedUserId: staff ? ticket.assignedUserId : undefined,
      assignedUserName: staff && ticket.assignedUserId ? this.users.findById(ticket.assignedUserId)?.name : undefined,
      messages: ticket.messages.filter(message => staff || !message.internal).map(message => ({
        id: message.id,
        authorUserId: message.authorUserId === actor.id ? actor.id : undefined,
        authorName: message.authorName,
        authorRole: message.authorRole,
        body: message.body,
        internal: staff ? message.internal : undefined,
        createdAt: message.createdAt
      })),
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      closedAt: ticket.closedAt
    };
  }

  private load() {
    if (!fs.existsSync(this.dataFile)) return;
    try {
      const records = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as SupportTicket[];
      for (const ticket of records) this.tickets.set(ticket.id, this.normalizeStoredTicket(ticket));
    } catch (error: any) {
      this.logger.error(`Failed to load support tickets: ${error?.message || error}`);
    }
  }

  private save() {
    const records = Array.from(this.tickets.values());
    if (this.database.enabled) {
      void this.database.replaceCollection('support-tickets', records, ticket => ticket.id)
        .catch(error => this.logger.error(`Failed to persist support tickets: ${error?.message || error}`));
      return;
    }
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(records, null, 2));
  }
}
