import { IsOptional, IsString } from 'class-validator';

// RFC 7009 token revocation request (form-urlencoded or JSON)
export class RevokeTokenDto {
  @IsString()
  @IsOptional()
  token?: string;

  @IsString()
  @IsOptional()
  token_type_hint?: string;

  @IsString()
  @IsOptional()
  client_id?: string;

  @IsString()
  @IsOptional()
  client_secret?: string;
}
