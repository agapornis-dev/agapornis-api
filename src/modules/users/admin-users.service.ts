import { Injectable } from '@nestjs/common';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityEvents } from '../../common/events/activity-events';
import { DomainError } from '../../common/errors/domain-errors';
import { DatabaseService } from '../database/database.service';
import { ServerRecord, ServerRegistryService } from '../servers/services/server-registry.service';
import { validateUserRoleUpdate } from '../validator/auth';
import { UserPolicy } from './user.policy';
import { UsersService } from './users.service';
import type { Actor } from '../../common/decorators/actor.decorator';
import type { UpdateUserRoleDto } from './dto/admin-user.dto';

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly users: UsersService,
    private readonly servers: ServerRegistryService,
    private readonly activityLog: ActivityLogService,
    private readonly userPolicy: UserPolicy,
    private readonly database: DatabaseService,
  ) {}

  async list() {
    const servers = await this.servers.listAccessIndex();
    return this.users.list().map(user => {
      const accessible = servers.filter((server: ServerRecord) => server.ownerUserId === user.id || server.collaboratorUserIds?.includes(user.id));
      return {
        ...user,
        serverCount: accessible.length,
        ownedServerCount: accessible.filter((server: ServerRecord) => server.ownerUserId === user.id).length,
        sharedServerCount: accessible.filter((server: ServerRecord) => server.ownerUserId !== user.id).length,
      };
    });
  }

  async get(id: string) {
    const user = this.users.findById(id);
    if (!user) throw new DomainError('user not found', 'not_found');
    const servers = (await this.servers.listAccessIndex())
      .filter((server: ServerRecord) => server.ownerUserId === id || server.collaboratorUserIds?.includes(id))
      .map((server: ServerRecord) => {
        const collaborator = server.collaborators?.find(entry => entry.userId === id);
        return {
          id: server.id,
          nodeId: server.nodeId,
          name: server.name,
          ownerUserId: server.ownerUserId,
          status: server.status,
          createdAt: server.createdAt,
          access: server.ownerUserId === id
            ? { relationship: 'owner', permission: 'owner', canWrite: true, permissions: [] }
            : {
                relationship: 'collaborator',
                permission: collaborator?.permission || 'read_only',
                canWrite: collaborator?.permission === 'operator',
                permissions: collaborator?.permissions || [],
              },
        };
      });
    const activity = await this.activityLog.summariesForUser(id, 100);
    return {
      ...this.users.adminUser(user),
      servers,
      activity,
    };
  }

  async setRole(id: string, body: UpdateUserRoleDto, actor: Actor, ip?: string) {
    const data = validateUserRoleUpdate(body);
    const target = this.users.findById(id);
    if (!target) throw new DomainError('user not found', 'not_found');

    this.userPolicy.assertCanChangeRole(actor, target, data.role);
    const result = this.users.setRole(id, data.role);
    this.activityLog.log({
      event: ActivityEvents.UserRoleChanged,
      userId: actor.id,
      userName: actor.name,
      meta: { targetUserId: id, role: data.role },
      ip,
    });
    return result;
  }

  async remove(id: string, actor: Actor, ip?: string) {
    const target = this.users.findById(id);
    if (!target) throw new DomainError('user not found', 'not_found');
    const ownedServers = (await this.servers.listAccessIndex())
      .filter((server: ServerRecord) => server.ownerUserId === id);

    this.userPolicy.assertCanDelete(actor, target, ownedServers.length);

    const removeWork = async () => {
      const removed = this.users.remove(id);
      await this.servers.removeUserCollaborations(id);
      await this.activityLog.pruneByUserId(id);
      this.activityLog.log({
        event: ActivityEvents.UserDeleted,
        userId: actor.id,
        userName: actor.name,
        meta: { targetUserId: id, targetUserName: removed.name },
        ip,
      });
      return { deleted: true, user: { id: removed.id, name: removed.name } };
    };

    if (!this.database.enabled) return removeWork();
    return this.database.transaction(removeWork, { isolation: 'SERIALIZABLE', retries: 3 });
  }
}
