import type { CollectionTable } from '../schema.types';
import { parseJson, ts } from '../schema.helpers';

export const SUPPORT_TICKETS_TABLE: CollectionTable = {
  namespace: 'support-tickets',
  table: 'support_tickets',
  keyColumn: 'ticket_id',
  columns: [
    { name: 'user_id', type: 'VARCHAR(64) NOT NULL' },
    { name: 'requester_name', type: 'VARCHAR(255) NOT NULL' },
    { name: 'requester_email', type: 'VARCHAR(255) NOT NULL' },
    { name: 'subject', type: 'VARCHAR(255) NOT NULL' },
    { name: 'category', type: "VARCHAR(24) NOT NULL DEFAULT 'general'" },
    { name: 'priority', type: "VARCHAR(24) NOT NULL DEFAULT 'normal'" },
    { name: 'status', type: "VARCHAR(40) NOT NULL DEFAULT 'open'" },
    { name: 'assigned_user_id', type: 'VARCHAR(64)' },
    { name: 'messages', type: 'TEXT NOT NULL' },
    { name: 'created_at', type: '${date} NOT NULL' },
    { name: 'closed_at', type: '${date}' },
  ],
  toRow: (v: any) => [
    v.userId, v.requesterName, v.requesterEmail, v.subject,
    v.category, v.priority, v.status, v.assignedUserId || null,
    JSON.stringify(v.messages || []),
    v.createdAt, v.closedAt || null,
  ],
  fromRow: (r: any) => ({
    id: r.ticket_id,
    userId: r.user_id,
    requesterName: r.requester_name,
    requesterEmail: r.requester_email,
    subject: r.subject,
    category: r.category,
    priority: r.priority,
    status: r.status,
    assignedUserId: r.assigned_user_id || undefined,
    messages: parseJson(r.messages, []),
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
    closedAt: r.closed_at ? ts(r.closed_at) : undefined,
  }),
  indexes: [
    { name: 'idx_support_tickets_user', columns: 'user_id, updated_at DESC' },
    { name: 'idx_support_tickets_status', columns: 'status, updated_at DESC' },
  ],
};
