export const ActivityEvents = {
  UserRoleChanged: 'user.role_changed',
  UserDeleted: 'user.deleted',
  AgentCertificateRotated: 'agent.certificate_rotated',
  AgentCertificateActivated: 'agent.certificate_activated',
  AgentCertificateRevoked: 'agent.certificate_revoked',
  AgentUpdateApplied: 'agent.update_applied',
} as const;

export type ActivityEvent = typeof ActivityEvents[keyof typeof ActivityEvents];
