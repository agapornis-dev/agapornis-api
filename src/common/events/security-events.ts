export const SecurityEvents = {
  RoleChangeDenied: 'security.role_change_denied',
  UserDeleteDenied: 'security.user_delete_denied',
  AgentUpdateRejected: 'security.agent_update_rejected',
  CertificateRotationRejected: 'security.certificate_rotation_rejected',
} as const;

export type SecurityEvent = typeof SecurityEvents[keyof typeof SecurityEvents];
