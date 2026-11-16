import { Injectable } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class OAuthRepository {
  constructor(
    private _oauthApp: PrismaRepository<'oAuthApp'>,
    private _oauthAuth: PrismaRepository<'oAuthAuthorization'>,
    private _oauthSelfHosted: PrismaRepository<'oAuthSelfHostedAuthorization'>,
    private _userOrganization: PrismaRepository<'userOrganization'>,
    private _oauthToken: PrismaRepository<'oAuthToken'>,
    private _transaction: PrismaTransaction
  ) {}

  // --- Rotating tokens of MCP (dynamic) clients ---------------------------
  // Consume an authorization code exactly once: only the first of two
  // concurrent exchanges sees count 1
  async consumeCode(id: string, encryptedCode: string) {
    const { count } = await this._oauthAuth.model.oAuthAuthorization.updateMany({
      where: { id, authorizationCode: encryptedCode },
      data: {
        authorizationCode: null,
        codeExpiresAt: null,
        codeChallenge: null,
        codeChallengeMethod: null,
        redirectUri: null,
      },
    });
    return count === 1;
  }

  issueTokens(data: {
    authorizationId: string;
    familyId: string;
    scope: string;
    resource: string | null;
    access: { hash: string; expiresAt: Date };
    refresh: { hash: string; expiresAt: Date };
  }) {
    return this._oauthToken.model.oAuthToken.createMany({
      data: [
        {
          authorizationId: data.authorizationId,
          kind: 'access',
          tokenHash: data.access.hash,
          familyId: data.familyId,
          scope: data.scope,
          resource: data.resource,
          expiresAt: data.access.expiresAt,
        },
        {
          authorizationId: data.authorizationId,
          kind: 'refresh',
          tokenHash: data.refresh.hash,
          familyId: data.familyId,
          scope: data.scope,
          resource: data.resource,
          expiresAt: data.refresh.expiresAt,
        },
      ],
    });
  }

  findTokenByHash(tokenHash: string) {
    return this._oauthToken.model.oAuthToken.findUnique({
      where: { tokenHash },
      include: {
        authorization: {
          include: {
            oauthApp: {
              select: { id: true, clientId: true, dynamic: true, redirectUris: true },
            },
            user: { select: { id: true, email: true, activated: true } },
            organization: {
              include: {
                subscription: {
                  select: {
                    subscriptionTier: true,
                    totalChannels: true,
                    isLifetime: true,
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  // Rotation in one transaction: the old refresh token is marked used only
  // if nobody used it yet, and the new pair exists only if that succeeded
  async rotateRefresh(
    oldId: string,
    next: Parameters<OAuthRepository['issueTokens']>[0]
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      const { count } = await tx.oAuthToken.updateMany({
        where: { id: oldId, usedAt: null, revokedAt: null },
        data: { usedAt: new Date() },
      });
      if (count !== 1) {
        return false;
      }
      await tx.oAuthToken.createMany({
        data: [
          {
            authorizationId: next.authorizationId,
            kind: 'access',
            tokenHash: next.access.hash,
            familyId: next.familyId,
            scope: next.scope,
            resource: next.resource,
            expiresAt: next.access.expiresAt,
          },
          {
            authorizationId: next.authorizationId,
            kind: 'refresh',
            tokenHash: next.refresh.hash,
            familyId: next.familyId,
            scope: next.scope,
            resource: next.resource,
            expiresAt: next.refresh.expiresAt,
          },
        ],
      });
      return true;
    });
  }

  // The one extra pair a client may get when it sent the same refresh
  // twice at once: only while the old token is unrevoked and was used within
  // the grace window, and it is then spent for good (revokedAt), in the same
  // transaction as the new pair. A revoke or re-consent in between wins
  async graceReissue(
    oldId: string,
    usedSince: Date,
    next: Parameters<OAuthRepository['issueTokens']>[0]
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      const { count } = await tx.oAuthToken.updateMany({
        where: { id: oldId, revokedAt: null, usedAt: { gte: usedSince } },
        data: { revokedAt: new Date() },
      });
      if (count !== 1) {
        return false;
      }
      await tx.oAuthToken.createMany({
        data: [
          {
            authorizationId: next.authorizationId,
            kind: 'access',
            tokenHash: next.access.hash,
            familyId: next.familyId,
            scope: next.scope,
            resource: next.resource,
            expiresAt: next.access.expiresAt,
          },
          {
            authorizationId: next.authorizationId,
            kind: 'refresh',
            tokenHash: next.refresh.hash,
            familyId: next.familyId,
            scope: next.scope,
            resource: next.resource,
            expiresAt: next.refresh.expiresAt,
          },
        ],
      });
      return true;
    });
  }

  // Tokens long expired are of no use to anyone: kept 30 days for audit
  pruneExpiredTokens(olderThan: Date) {
    return this._oauthToken.model.oAuthToken.deleteMany({
      where: { expiresAt: { lt: olderThan } },
    });
  }

  // A refresh token replayed after it was spent: its family ends (not the
  // grant, which a re-consent may have opened again with a new family)
  revokeFamily(familyId: string) {
    return this._oauthToken.model.oAuthToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // A replayed refresh token: every token of its family and the grant end
  async revokeFamilyAndGrant(familyId: string, authorizationId: string) {
    await this._transaction.model.$transaction([
      this._oauthToken.model.oAuthToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this._oauthAuth.model.oAuthAuthorization.update({
        where: { id: authorizationId },
        data: { revokedAt: new Date() },
        select: { id: true },
      }),
    ]);
  }

  // Re-consent or revoke: every earlier token of the grant ends
  revokeTokensOfAuthorization(authorizationId: string) {
    return this._oauthToken.model.oAuthToken.updateMany({
      where: { authorizationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // Whether the user who granted access still belongs to the organization:
  // a removed or disabled member, a deleted user or a deleted organization
  // ends every OAuth grant they made
  async isActiveMember(userId: string, organizationId: string) {
    return !!(await this._userOrganization.model.userOrganization.findFirst({
      where: {
        userId,
        organizationId,
        disabled: false,
        user: { deletedAt: null, activated: true },
        organization: { deletedAt: null },
      },
      select: { id: true },
    }));
  }

  getAppByOrgId(orgId: string) {
    return this._oauthApp.model.oAuthApp.findFirst({
      where: {
        organizationId: orgId,
        deletedAt: null,
      },
      include: {
        picture: true,
      },
    });
  }

  getAppByClientId(clientId: string) {
    return this._oauthApp.model.oAuthApp.findFirst({
      where: {
        clientId,
        deletedAt: null,
      },
      include: {
        picture: true,
      },
    });
  }

  createApp(
    orgId: string,
    data: {
      name: string;
      description?: string;
      pictureId?: string;
      redirectUrl: string;
      clientId: string;
      clientSecret: string;
    }
  ) {
    return this._oauthApp.model.oAuthApp.create({
      data: {
        organizationId: orgId,
        name: data.name,
        description: data.description,
        pictureId: data.pictureId,
        redirectUrl: data.redirectUrl,
        clientId: data.clientId,
        clientSecret: data.clientSecret,
      },
      include: {
        picture: true,
      },
    });
  }

  createDynamicApp(data: {
    name: string;
    redirectUrl: string;
    redirectUris: string;
    clientId: string;
    clientSecret?: string;
    tokenEndpointAuthMethod: string;
  }) {
    return this._oauthApp.model.oAuthApp.create({
      data: {
        name: data.name,
        redirectUrl: data.redirectUrl,
        redirectUris: data.redirectUris,
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        tokenEndpointAuthMethod: data.tokenEndpointAuthMethod,
        dynamic: true,
      },
    });
  }

  // Dynamic clients register before the consent screen, so abandoned flows
  // leave orphan rows; prune the ones no user ever authorized
  deleteStaleDynamicApps(olderThan: Date) {
    return this._oauthApp.model.oAuthApp.deleteMany({
      where: {
        dynamic: true,
        createdAt: { lt: olderThan },
        authorizations: { none: {} },
        selfHostedAuthorizations: { none: {} },
      },
    });
  }

  async updateApp(
    orgId: string,
    data: {
      name?: string;
      description?: string;
      pictureId?: string;
      redirectUrl?: string;
    }
  ) {
    const app = await this._oauthApp.model.oAuthApp.findFirst({
      where: {
        organizationId: orgId,
        deletedAt: null,
      },
    });
    if (!app) {
      return null;
    }
    return this._oauthApp.model.oAuthApp.update({
      where: { id: app.id },
      data,
      include: {
        picture: true,
      },
    });
  }

  async deleteApp(orgId: string) {
    const app = await this._oauthApp.model.oAuthApp.findFirst({
      where: {
        organizationId: orgId,
        deletedAt: null,
      },
    });
    if (!app) {
      return null;
    }
    return this._oauthApp.model.oAuthApp.update({
      where: { id: app.id },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async updateClientSecret(orgId: string, newSecret: string) {
    const app = await this._oauthApp.model.oAuthApp.findFirst({
      where: {
        organizationId: orgId,
        deletedAt: null,
      },
    });
    if (!app) {
      return null;
    }
    return this._oauthApp.model.oAuthApp.update({
      where: { id: app.id },
      data: {
        clientSecret: newSecret,
      },
    });
  }

  createAuthorization(data: {
    oauthAppId: string;
    userId: string;
    organizationId: string;
    authorizationCode: string;
    codeExpiresAt: Date;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    redirectUri?: string;
    scope?: string | null;
  }) {
    return this._oauthAuth.model.oAuthAuthorization.upsert({
      where: {
        oauthAppId_userId_organizationId: {
          oauthAppId: data.oauthAppId,
          userId: data.userId,
          organizationId: data.organizationId,
        },
      },
      create: {
        oauthAppId: data.oauthAppId,
        userId: data.userId,
        organizationId: data.organizationId,
        authorizationCode: data.authorizationCode,
        codeExpiresAt: data.codeExpiresAt,
        codeChallenge: data.codeChallenge || null,
        codeChallengeMethod: data.codeChallengeMethod || null,
        redirectUri: data.redirectUri || null,
        scope: data.scope ?? null,
      },
      update: {
        authorizationCode: data.authorizationCode,
        codeExpiresAt: data.codeExpiresAt,
        codeChallenge: data.codeChallenge || null,
        codeChallengeMethod: data.codeChallengeMethod || null,
        redirectUri: data.redirectUri || null,
        scope: data.scope ?? null,
        accessToken: null,
        revokedAt: null,
      },
    });
  }

  findByCode(encryptedCode: string) {
    return this._oauthAuth.model.oAuthAuthorization.findFirst({
      where: {
        authorizationCode: encryptedCode,
        revokedAt: null,
      },
      include: { organization: { select: { paymentId: true } } },
    });
  }

  // RFC 7009 revocation of a legacy (long-lived) token: its grant ends
  revokeAuthorizationById(id: string) {
    return this._oauthAuth.model.oAuthAuthorization.update({
      where: { id },
      data: { revokedAt: new Date() },
      select: { id: true },
    });
  }

  // after a legacy (long-lived) token moved to a rotating family it stops
  clearLegacyAccessToken(id: string) {
    return this._oauthAuth.model.oAuthAuthorization.update({
      where: { id },
      data: { accessToken: null },
      select: { id: true },
    });
  }

  exchangeCodeForToken(id: string, encryptedToken: string) {
    return this._oauthAuth.model.oAuthAuthorization.update({
      where: { id },
      select: {
        organizationId: true,
        organization: {
          select: {
            paymentId: true,
          }
        }
      },
      data: {
        accessToken: encryptedToken,
        authorizationCode: null,
        codeExpiresAt: null,
        codeChallenge: null,
        codeChallengeMethod: null,
        redirectUri: null,
      },
    });
  }

  findByAccessToken(encryptedToken: string) {
    return this._oauthAuth.model.oAuthAuthorization.findFirst({
      where: {
        accessToken: encryptedToken,
        revokedAt: null,
      },
      include: {
        oauthApp: {
          select: {
            clientId: true,
            dynamic: true,
            redirectUris: true,
          },
        },
        organization: {
          include: {
            subscription: {
              select: {
                subscriptionTier: true,
                totalChannels: true,
                isLifetime: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
            email: true,
            activated: true,
          },
        },
      },
    });
  }

  // A live connection: a legacy long-lived token, or a rotating (H2) token
  // that is still valid. Only the fields the screens show are read: never a
  // token, a code or an app secret
  private liveConnectionsWhere(extra: Record<string, unknown>) {
    return {
      ...extra,
      revokedAt: null,
      OR: [
        { accessToken: { not: null } },
        { tokens: { some: { revokedAt: null, expiresAt: { gt: new Date() } } } },
      ],
    };
  }

  private connectionSelect(withUser: boolean) {
    return {
      id: true,
      createdAt: true,
      oauthApp: {
        select: {
          name: true,
          description: true,
          picture: { select: { path: true } },
        },
      },
      ...(withUser ? { user: { select: { name: true, email: true } } } : {}),
    };
  }

  getApprovedApps(userId: string) {
    return this._oauthAuth.model.oAuthAuthorization.findMany({
      where: this.liveConnectionsWhere({ userId }),
      select: this.connectionSelect(false),
      orderBy: { createdAt: 'desc' },
    });
  }

  // every live connection in an organization, with who made it (admins)
  getOrganizationConnections(organizationId: string) {
    return this._oauthAuth.model.oAuthAuthorization.findMany({
      // made by someone still an active member (removed members' grants
      // already stop working, see isActiveMember)
      where: this.liveConnectionsWhere({
        organizationId,
        user: {
          deletedAt: null,
          organizations: { some: { organizationId, disabled: false } },
        },
      }),
      select: this.connectionSelect(true),
      orderBy: { createdAt: 'desc' },
    });
  }

  revokeOrganizationConnection(organizationId: string, authId: string) {
    return this._oauthAuth.model.oAuthAuthorization.updateMany({
      where: { id: authId, organizationId },
      data: { revokedAt: new Date() },
    });
  }

  revokeAuthorization(userId: string, authId: string) {
    return this._oauthAuth.model.oAuthAuthorization.updateMany({
      where: { id: authId, userId },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForApp(oauthAppId: string) {
    await this._oauthSelfHosted.model.oAuthSelfHostedAuthorization.updateMany({
      where: {
        oauthAppId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    return this._oauthAuth.model.oAuthAuthorization.updateMany({
      where: {
        oauthAppId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  // holds the instance API key, so only the id comes back
  createSelfHostedAuthorization(data: {
    oauthAppId: string;
    mcpUrl: string;
    apiKey: string;
    email?: string;
    authorizationCode: string;
    codeExpiresAt: Date;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    redirectUri?: string;
  }) {
    return this._oauthSelfHosted.model.oAuthSelfHostedAuthorization.create({
      select: {
        id: true,
      },
      data: {
        oauthAppId: data.oauthAppId,
        mcpUrl: data.mcpUrl,
        apiKey: data.apiKey,
        email: data.email || null,
        authorizationCode: data.authorizationCode,
        codeExpiresAt: data.codeExpiresAt,
        codeChallenge: data.codeChallenge || null,
        codeChallengeMethod: data.codeChallengeMethod || null,
        redirectUri: data.redirectUri || null,
      },
    });
  }

  // Abandoned consent flows leave rows (and API keys) that never got a token
  deleteAbandonedSelfHostedAuthorizations(olderThan: Date) {
    return this._oauthSelfHosted.model.oAuthSelfHostedAuthorization.deleteMany(
      {
        where: {
          accessToken: null,
          createdAt: { lt: olderThan },
        },
      }
    );
  }

  findSelfHostedByCode(encryptedCode: string) {
    return this._oauthSelfHosted.model.oAuthSelfHostedAuthorization.findFirst({
      where: {
        authorizationCode: encryptedCode,
        revokedAt: null,
      },
      select: {
        id: true,
        oauthAppId: true,
        codeExpiresAt: true,
        codeChallenge: true,
        redirectUri: true,
      },
    });
  }

  exchangeSelfHostedCodeForToken(id: string, encryptedToken: string) {
    return this._oauthSelfHosted.model.oAuthSelfHostedAuthorization.update({
      where: { id },
      select: {
        id: true,
      },
      data: {
        accessToken: encryptedToken,
        authorizationCode: null,
        codeExpiresAt: null,
        codeChallenge: null,
        codeChallengeMethod: null,
        redirectUri: null,
      },
    });
  }

  findSelfHostedByAccessToken(encryptedToken: string) {
    return this._oauthSelfHosted.model.oAuthSelfHostedAuthorization.findFirst({
      where: {
        accessToken: encryptedToken,
        revokedAt: null,
      },
      select: {
        id: true,
        oauthAppId: true,
        mcpUrl: true,
        apiKey: true,
      },
    });
  }

  findSelfHostedUserInfo(encryptedToken: string) {
    return this._oauthSelfHosted.model.oAuthSelfHostedAuthorization.findFirst({
      where: {
        accessToken: encryptedToken,
        revokedAt: null,
      },
      select: {
        id: true,
        email: true,
        oauthApp: {
          select: {
            clientId: true,
            dynamic: true,
            redirectUris: true,
          },
        },
      },
    });
  }

  deleteSelfHostedAuthorization(id: string) {
    return this._oauthSelfHosted.model.oAuthSelfHostedAuthorization.deleteMany(
      {
        where: { id },
      }
    );
  }
}
