import { IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;
const USERNAME_MSG =
  'Username must be 3-20 characters and contain only lowercase letters, digits, and underscores';

export class SetUsernameDto {
  @ApiProperty({ description: 'Unique username (3-20 characters)', minLength: 3, maxLength: 20 })
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  @Matches(USERNAME_REGEX, { message: USERNAME_MSG })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value))
  username!: string;
}
