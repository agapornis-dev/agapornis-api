export class CreateTicketDto {
  subject?: string;
  message?: string;
  category?: string;
  priority?: string;
}

export class ReplyTicketDto {
  message?: string;
  internal?: boolean;
}

export class UpdateTicketDto {
  status?: string;
  priority?: string;
  assignedUserId?: string | null;
}
