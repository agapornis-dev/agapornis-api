import { requestObject, stringField, urlField } from '../common/request-validation';

export function validateSocialExchange(input: unknown) {
  const body = requestObject(input);
  return {
    code: stringField(body, 'code', { required: true, min: 1, max: 4096 }),
    redirectUri: urlField(body, 'redirectUri'),
    codeVerifier: stringField(body, 'codeVerifier', { required: true, min: 16, max: 256 })
  };
}
