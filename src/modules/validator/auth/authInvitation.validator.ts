import { numberField, optionalEmailField, requestObject, stringField } from '../common/request-validation';

export function validateInvitationCreate(input: unknown) {
  const body = requestObject(input);
  const expiresField = body.expiresInHours === undefined ? 'expires_in_hours' : 'expiresInHours';
  return {
    label: stringField(body, 'label', { max: 160 }),
    email: optionalEmailField(body),
    expiresInHours: numberField(body, expiresField, { min: 1, max: 720, fallback: 168 })
  };
}
