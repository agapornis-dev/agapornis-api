import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';

export type NotificationType = 'ticket_created' | 'ticket_reply' | 'ticket_status';

export interface NotificationRecord {
  id: string;
  recipientUserId: string;
  type: NotificationType;
  title: string;
  message: string;
  href?: string;
  resourceId?: string;
  actorUserId?: string;
  createdAt: string;
  readAt?: string;
}
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly notifications = new Map<string, NotificationRecord>();
  private readonly dataFile = path.join(__dirname, '..', '..', 'data', 'notifications.json');

  constructor(private readonly database: DatabaseService) {
    this.load();
  }

  async onModuleInit() {
    if (!this.database.enabled) return;
    const stored = await this.database.hydrateCollection('notifications', Array.from(this.notifications.values()), item => item.id);
    this.notifications.clear();
    for (const item of stored) this.notifications.set(item.id, item);
  }

  list(userId: string, limit = 50) {
    return Array.from(this.notifications.values())
      .filter(item => item.recipientUserId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.min(100, Math.max(1, limit)))
      .map(item => this.clientRecord(item));
  }

  unreadCount(userId: string) {
    return Array.from(this.notifications.values()).filter(item => item.recipientUserId === userId && !item.readAt).length;
  }

  create(input: Omit<NotificationRecord, 'id' | 'createdAt' | 'readAt'>) {
    const notification: NotificationRecord = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    };
    this.notifications.set(notification.id, notification);
    this.prune();
    this.save();
    return { ...notification };
  }

  createForUsers(userIds: string[], input: Omit<NotificationRecord, 'id' | 'recipientUserId' | 'createdAt' | 'readAt'>) {
    return Array.from(new Set(userIds.filter(Boolean))).map(recipientUserId => this.create({ ...input, recipientUserId }));
  }

  markRead(id: string, userId: string) {
    const item = this.notifications.get(id);
    if (!item || item.recipientUserId !== userId) throw new NotFoundException('notification not found');
    item.readAt ||= new Date().toISOString();
    this.save();
    return { id: item.id, readAt: item.readAt };
  }

  markAllRead(userId: string) {
    const readAt = new Date().toISOString();
    let updated = 0;
    for (const item of this.notifications.values()) {
      if (item.recipientUserId !== userId || item.readAt) continue;
      item.readAt = readAt;
      updated += 1;
    }
    if (updated) this.save();
    return { updated };
  }

  removeForUser(userId: string) {
    let updated = false;
    for (const [id, item] of this.notifications) {
      if (item.recipientUserId !== userId) continue;
      this.notifications.delete(id);
      updated = true;
    }
    if (updated) this.save();
  }

  private clientRecord(item: NotificationRecord) {
    return {
      id: item.id,
      type: item.type,
      title: item.title,
      message: item.message,
      href: item.href,
      createdAt: item.createdAt,
      readAt: item.readAt
    };
  }

  private prune() {
    const records = Array.from(this.notifications.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const perUser = new Map<string, number>();
    for (const item of records) {
      const count = perUser.get(item.recipientUserId) || 0;
      if (count >= 200) this.notifications.delete(item.id);
      else perUser.set(item.recipientUserId, count + 1);
    }
  }

  private load() {
    if (!fs.existsSync(this.dataFile)) return;
    try {
      const records = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as NotificationRecord[];
      for (const item of records) this.notifications.set(item.id, item);
    } catch (error: any) {
      this.logger.error(`Failed to load notifications: ${error?.message || error}`);
    }
  }

  private save() {
    const records = Array.from(this.notifications.values());
    if (this.database.enabled) {
      void this.database.replaceCollection('notifications', records, item => item.id)
        .catch(error => this.logger.error(`Failed to persist notifications: ${error?.message || error}`));
      return;
    }
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(records, null, 2));
  }
}
