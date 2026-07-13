import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/decorators/actor.decorator';
import { DomainError } from '../../common/errors/domain-errors';
import type { UserRecord, UserRole } from './users.service';

@Injectable()
export class UserPolicy {
  assertCanChangeRole(actor: Actor, target: UserRecord, nextRole: UserRole) {
    if (actor.role === 'owner') return;
    if (['owner', 'admin'].includes(target.role) || ['owner', 'admin'].includes(nextRole)) {
      throw new DomainError('only an owner can manage administrator and owner roles', 'forbidden');
    }
  }

  assertCanDelete(actor: Actor, target: UserRecord, ownedServerCount: number) {
    if (target.id === actor.id) {
      throw new DomainError('you cannot delete your own account', 'conflict');
    }
    if (target.role === 'owner') {
      throw new DomainError('owner accounts must be demoted before deletion', 'conflict');
    }
    if (ownedServerCount > 0) {
      throw new DomainError('transfer or delete this user\'s servers first', 'conflict');
    }
  }
}
