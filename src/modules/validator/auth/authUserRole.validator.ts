import { BadRequestException } from '@nestjs/common';
import { requestObject, stringField } from '../common/request-validation';
import { UserRole } from '../../users/users.service';

const ROLES = new Set<UserRole>(['owner', 'admin', 'support', 'user']);

export function validateUserRoleUpdate(input: unknown) {
  const body = requestObject(input);
  const role = stringField(body, 'role', { required: true, max: 24 }) as UserRole;
  if (!ROLES.has(role)) {
    throw new BadRequestException('invalid role');
  }
  return { role };
}
