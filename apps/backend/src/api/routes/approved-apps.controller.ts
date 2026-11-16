import {
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
} from '@nestjs/common';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization, User } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { OAuthService } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';

// The caller's role in the current organization, the same field the
// permissions guard reads. Checked here as well because without billing
// configured the policy check allows every section, and these routes show
// members' emails and revoke other people's access
const assertOrganizationAdmin = (org: Organization) => {
  const role = (org as any)?.users?.[0]?.role;
  if (role !== 'ADMIN' && role !== 'SUPERADMIN') {
    throw new HttpException(
      { msg: 'Only an organization admin can manage every connection' },
      HttpStatus.FORBIDDEN
    );
  }
};

@ApiTags('Approved Apps')
@Controller('/user/approved-apps')
export class ApprovedAppsController {
  constructor(private _oauthService: OAuthService) {}

  @Get('/')
  async list(@GetUserFromRequest() user: User) {
    return this._oauthService.getApprovedApps(user.id);
  }

  // every app connected to this organization, by anyone (admins only)
  @Get('/organization')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async organizationConnections(@GetOrgFromRequest() org: Organization) {
    assertOrganizationAdmin(org);
    return this._oauthService.getOrganizationConnections(org.id);
  }

  @Delete('/organization/:id')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async revokeOrganizationConnection(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    assertOrganizationAdmin(org);
    return this._oauthService.revokeOrganizationConnection(org.id, id);
  }

  @Delete('/:id')
  async revoke(
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this._oauthService.revokeApp(user.id, id);
  }
}
