import { oneTimeCodeField, requestObject, stringField } from '../common/request-validation';

export function validateTwoFactorLogin(input: unknown) {
  const body = requestObject(input);
  return {
    challengeToken: stringField(body, 'challengeToken', { required: true, min: 16, max: 4096 }),
    code: oneTimeCodeField(body)
  };
}

export function validateTwoFactorEnable(input: unknown) {
  const body = requestObject(input);
  return {
    setupToken: stringField(body, 'setupToken', { required: true, min: 16, max: 4096 }),
    code: oneTimeCodeField(body)
  };
}

export function validateTwoFactorDisable(input: unknown) {
  const body = requestObject(input);
  return {
    password: stringField(body, 'password', { max: 256, trim: false }),
    code: oneTimeCodeField(body)
  };
}

export function validateTwoFactorRecoveryCodes(input: unknown) {
  const body = requestObject(input);
  return { code: oneTimeCodeField(body) };
}
