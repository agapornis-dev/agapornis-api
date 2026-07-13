export const PASSWORD_POLICY = {
  minLength: 12,
  maxLength: 128,
  requiredCharacterClasses: 3,
} as const;

export type PasswordPolicySettings = {
  minLength: number;
  maxLength: number;
  requiredCharacterClasses: number;
};

const COMMON_PASSWORDS = new Set([
  'password',
  'password123',
  '123456789012',
  'qwerty123456',
  'letmein123456',
  'admin12345678',
]);

export function validatePassword(
  value: unknown,
  identity: { email?: string; name?: string } = {},
  policy: PasswordPolicySettings = PASSWORD_POLICY,
) {
  const password = String(value || '');
  if (password.length < policy.minLength) {
    throw new Error(`password must be at least ${policy.minLength} characters`);
  }
  if (password.length > policy.maxLength) {
    throw new Error(`password must be at most ${policy.maxLength} characters`);
  }

  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  if (classes < policy.requiredCharacterClasses) {
    throw new Error(`password must include at least ${policy.requiredCharacterClasses} of: lowercase, uppercase, number, or symbol`);
  }

  const normalized = password.toLocaleLowerCase();
  if (COMMON_PASSWORDS.has(normalized)) {
    throw new Error('password is too common');
  }

  const identityParts = [
    String(identity.email || '').split('@')[0],
    ...String(identity.name || '').split(/\s+/),
  ]
    .map(part => part.trim().toLocaleLowerCase())
    .filter(part => part.length >= 4);
  if (identityParts.some(part => normalized.includes(part))) {
    throw new Error('password must not contain your name or email address');
  }
}
