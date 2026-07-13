export class CreateBanDto {
  type?: 'email' | 'ip' | 'user';
  value?: string;
  email?: string;
  ip?: string;
  userId?: string;
  user_id?: string;
  reason?: string;
  expiresAt?: string;
  expires_at?: string;
  durationHours?: number;
  duration_hours?: number;
}
