import { emailField, requestObject, stringField } from '../common/request-validation';

export function validateProfileUpdate(input: unknown) {
  const body = requestObject(input);
  return {
    name: stringField(body, 'name', { required: true, min: 1, max: 255 }),
    email: emailField(body)
  };
}

export function validatePasswordChange(input: unknown) {
  const body = requestObject(input);
  return {
    currentPassword: stringField(body, 'currentPassword', { max: 256, trim: false }),
    newPassword: stringField(body, 'newPassword', { required: true, min: 1, max: 256, trim: false })
  };
}
