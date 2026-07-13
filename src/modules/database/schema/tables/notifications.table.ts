import type { CollectionTable } from '../schema.types';
import { ts } from '../schema.helpers';

export const NOTIFICATIONS_TABLE: CollectionTable = {
  namespace: 'notifications',
  table: 'notifications',
  keyColumn: 'notification_id',
  columns: [
    { name: 'recipient_user_id', type: 'VARCHAR(64) NOT NULL' },
    { name: 'type', type: 'VARCHAR(40) NOT NULL' },
    { name: 'title', type: 'VARCHAR(255) NOT NULL' },
    { name: 'message', type: 'TEXT NOT NULL' },
    { name: 'href', type: 'TEXT' },
    { name: 'resource_id', type: 'VARCHAR(160)' },
    { name: 'actor_user_id', type: 'VARCHAR(64)' },
    { name: 'created_at', type: '${date} NOT NULL' },
    { name: 'read_at', type: '${date}' },
  ],
  toRow: (v: any) => [
    v.recipientUserId, v.type, v.title, v.message,
    v.href || null, v.resourceId || null, v.actorUserId || null,
    v.createdAt, v.readAt || null,
  ],
  fromRow: (r: any) => ({
    id: r.notification_id,
    recipientUserId: r.recipient_user_id,
    type: r.type,
    title: r.title,
    message: r.message,
    href: r.href || undefined,
    resourceId: r.resource_id || undefined,
    actorUserId: r.actor_user_id || undefined,
    createdAt: ts(r.created_at),
    readAt: r.read_at ? ts(r.read_at) : undefined,
  }),
  indexes: [
    { name: 'idx_notifications_recipient', columns: 'recipient_user_id, created_at DESC' },
  ],
};
