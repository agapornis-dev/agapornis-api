export class CreateServerCollaboratorDto {
  userId?: string;
  email?: string;
  permission?: string;
  permissions?: string[];
}

export class UpdateServerCollaboratorDto {
  permission?: string;
  permissions?: string[];
}
