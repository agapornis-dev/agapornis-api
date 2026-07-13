import { emailField, requestObject, stringField } from '../common/request-validation';

export function validateAuthCreate(input: unknown) {
  const body = requestObject(input);
  return {
    email: emailField(body),
    password: stringField(body, 'password', { required: true, min: 1, max: 256, trim: false }),
    name: stringField(body, 'name', { max: 255 }),
    inviteKey: stringField(body, 'inviteKey', { max: 256 }) || stringField(body, 'invite_key', { max: 256 }),
    turnstileToken: stringField(body, 'turnstileToken', { max: 4096 }) || stringField(body, 'captchaToken', { max: 4096 }) || stringField(body, 'cfTurnstileResponse', { max: 4096 })
  };
}
