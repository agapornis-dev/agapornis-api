import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class BackupCatalogService {
  constructor(private readonly database: DatabaseService) {}

  async sync(serverId: string, backups: any[], observedAt = new Date().toISOString()) {
    if (!this.database.enabled) return;
    await this.database.transaction(async tx => {
      await this.database.advisoryLock(tx, `backup-quota:${serverId}`);
      const seen = new Set<string>();
      for (const backup of backups) {
        const backupId = String(backup.backup_id || backup.backupId || '');
        const storage = String(backup.storage || 'local');
        if (!backupId) continue;
        seen.add(`${storage}:${backupId}`);
        const duplicateClause = tx.clientType === 'postgres'
          ? " ON CONFLICT (server_id, backup_id, storage) DO UPDATE SET status = 'active'"
          : " ON DUPLICATE KEY UPDATE status = 'active'";
        await tx.query(
          `INSERT INTO server_backups (reservation_id, server_id, backup_id, storage, status, created_at)
           VALUES (${tx.placeholders(6)})${duplicateClause}`,
          [randomUUID(), serverId, backupId, storage, 'active', backup.created_at || backup.createdAt || new Date().toISOString()]
        );
      }
      const rows = await tx.query(
        `SELECT reservation_id, backup_id, storage FROM server_backups WHERE server_id = ${tx.placeholders(1)} AND status = 'active'`,
        [serverId]
      );
      for (const row of rows) {
        if (!seen.has(`${row.storage}:${row.backup_id}`)) {
          await tx.query(
            `DELETE FROM server_backups WHERE reservation_id = ${tx.placeholders(1)} AND created_at < ${tx.placeholders(1, 2)}`,
            [row.reservation_id, observedAt]
          );
        }
      }
    });
  }

  async reserve(serverId: string): Promise<string> {
    if (!this.database.enabled) return randomUUID();
    return this.database.transaction(async tx => {
      await this.database.advisoryLock(tx, `backup-quota:${serverId}`);
      const servers = await tx.query(
        `SELECT backup_limit FROM servers WHERE id = ${tx.placeholders(1)} FOR UPDATE`,
        [serverId]
      );
      if (!servers[0]) throw new Error('server not found');
      const limit = Number(servers[0].backup_limit || 0);
      if (limit <= 0) throw new Error('backups are not enabled for this server');
      const staleAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await tx.query(
        `DELETE FROM server_backups WHERE server_id = ${tx.placeholders(1)} AND status = 'pending' AND created_at < ${tx.placeholders(1, 2)}`,
        [serverId, staleAt]
      );
      const counts = await tx.query(
        `SELECT COUNT(*) AS count FROM server_backups WHERE server_id = ${tx.placeholders(1)} AND status IN ('pending', 'active')`,
        [serverId]
      );
      if (Number(counts[0]?.count || 0) >= limit) throw new Error(`backup limit of ${limit} reached`);
      const reservationId = randomUUID();
      await tx.query(
        `INSERT INTO server_backups (reservation_id, server_id, backup_id, storage, status, created_at) VALUES (${tx.placeholders(6)})`,
        [reservationId, serverId, null, 'pending', 'pending', new Date().toISOString()]
      );
      return reservationId;
    });
  }

  async complete(reservationId: string, serverId: string, response: any, storage: string) {
    if (!this.database.enabled) return;
    const backupId = String(response?.backup_id || response?.backupId || '');
    if (!backupId) throw new Error('agent did not return a backup id');
    await this.database.query(
      `UPDATE server_backups SET backup_id = ${this.database.placeholders(1)}, storage = ${this.database.placeholders(1, 2)}, status = 'active'
       WHERE reservation_id = ${this.database.placeholders(1, 3)} AND server_id = ${this.database.placeholders(1, 4)} AND status = 'pending'`,
      [backupId, storage, reservationId, serverId]
    );
  }

  async fail(reservationId: string) {
    if (this.database.enabled) {
      await this.database.query(
        `DELETE FROM server_backups WHERE reservation_id = ${this.database.placeholders(1)} AND status = 'pending'`,
        [reservationId]
      );
    }
  }

  async remove(serverId: string, backupId: string, storage: string) {
    if (this.database.enabled) {
      await this.database.query(
        `DELETE FROM server_backups WHERE server_id = ${this.database.placeholders(1)} AND backup_id = ${this.database.placeholders(1, 2)} AND storage = ${this.database.placeholders(1, 3)}`,
        [serverId, backupId, storage]
      );
    }
  }
}
