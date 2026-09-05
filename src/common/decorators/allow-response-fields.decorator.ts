import { SetMetadata } from '@nestjs/common';

export const ALLOW_RESPONSE_FIELDS_KEY = 'allowResponseFields';

export const AllowResponseFields = (...fields: string[]) =>
  SetMetadata(ALLOW_RESPONSE_FIELDS_KEY, fields);
