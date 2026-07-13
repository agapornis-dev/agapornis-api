import { emailField, requestObject, stringField } from '../common/request-validation';

export function validatePasswordResetRequest(input: unknown) {
  const body = requestObject(input);
  return { email: emailField(body) };
}

export function validatePasswordResetConfirm(input: unknown) {
  const body = requestObject(input);
  return {
    token: stringField(body, 'token', { required: true, min: 16, max: 4096 }),
    password: stringField(body, 'password', { required: true, min: 1, max: 256, trim: false })
  };
}
