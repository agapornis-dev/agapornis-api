import { requestObject, stringField } from '../common/request-validation';

export function validateEmailVerificationConfirm(input: unknown) {
  const body = requestObject(input);
  return {
    token: stringField(body, 'token', { required: true, min: 16, max: 4096 })
  };
}
