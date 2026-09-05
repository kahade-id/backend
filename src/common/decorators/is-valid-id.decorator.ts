import { registerDecorator, ValidationOptions } from 'class-validator';

const CUID_RE = /^c[a-z0-9]{24}$/;
const PREFIXED_ID_RE = /^[A-Z]{2,5}-[A-Za-z0-9_-]{3,80}$/;
const MAX_ID_LENGTH = 100;

export function IsValidId(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidId',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be a valid ID`,
        ...validationOptions,
      },
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
            return false;
          }
          return CUID_RE.test(value) || PREFIXED_ID_RE.test(value);
        },
      },
    });
  };
}
