import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { streamUploadOptions } from '@gitroom/nestjs-libraries/upload/multer.stream.engine';
import { omit } from 'lodash';
import { ApiTags } from '@nestjs/swagger';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetIncludeDeletedFromRequest } from '@gitroom/nestjs-libraries/user/include.deleted.from.request';
import { GetOAuthUserIdFromRequest } from '@gitroom/nestjs-libraries/user/oauth.user.id.from.request';
import { Organization } from '@prisma/client';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { ChangePostStatusDto } from '@gitroom/nestjs-libraries/dtos/posts/change.post.status.dto';
import { UpdatePostSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/update.post.settings.dto';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';
import { VideoDto } from '@gitroom/nestjs-libraries/dtos/videos/video.dto';
import { VideoFunctionDto } from '@gitroom/nestjs-libraries/dtos/videos/video.function.dto';
import { UploadDto } from '@gitroom/nestjs-libraries/dtos/media/upload.dto';
import { GetMediaDto } from '@gitroom/nestjs-libraries/dtos/media/get.media.dto';
import { ClippingDto } from '@gitroom/nestjs-libraries/dtos/clipping/clipping.dto';
import { ConnectLinkDto } from '@gitroom/nestjs-libraries/dtos/integrations/connect.link.dto';
import { ClippingService } from '@gitroom/nestjs-libraries/database/prisma/clipping/clipping.service';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { GetNotificationsDto } from '@gitroom/nestjs-libraries/dtos/notifications/get.notifications.dto';
import * as Sentry from '@sentry/nestjs';
import { publishReason } from '@gitroom/nestjs-libraries/chat/human.approval';
import { publicApproval } from '@gitroom/nestjs-libraries/chat/public.approval';
import {
  socialIntegrationList,
  IntegrationManager,
} from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { getValidationSchemas } from '@gitroom/nestjs-libraries/chat/validation.schemas.helper';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { PostValidationException } from '@gitroom/backend/api/routes/posts.validation.exception';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { SuperAdminGuard } from '@gitroom/backend/services/auth/super.admin.guard';
import { timer } from '@gitroom/helpers/utils/timer';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { AdminStatsService } from '@gitroom/nestjs-libraries/database/prisma/admin-stats/admin-stats.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { GetOrgActivityDto } from '@gitroom/nestjs-libraries/dtos/analytics/get.org.activity.dto';
import { ResetCreditsDto } from '@gitroom/nestjs-libraries/dtos/billing/reset.credits.dto';
import { SubscriptionService } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import dayjs from 'dayjs';

@ApiTags('Public API')
@Controller('/public/v1')
export class PublicIntegrationsController {
  constructor(
    private _integrationService: IntegrationService,
    private _postsService: PostsService,
    private _mediaService: MediaService,
    private _notificationService: NotificationService,
    private _integrationManager: IntegrationManager,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _usersService: UsersService,
    private _adminStatsService: AdminStatsService,
    private _organizationService: OrganizationService,
    private _clippingService: ClippingService,
    private _subscriptionService: SubscriptionService
  ) {}

  @Post('/upload')
  @UseInterceptors(FileInterceptor('file', streamUploadOptions()))
  async uploadSimple(
    @GetOrgFromRequest() org: Organization,
    @UploadedFile('file') file: Express.Multer.File,
    @Body('adjust') adjust: string = 'false'
  ) {
    Sentry.metrics.count('public_api-request', 1);
    if (!file) {
      throw new HttpException({ msg: 'No file provided' }, 400);
    }

    if (adjust === 'true') {
      return this._mediaService.saveUploadedFile(
        org.id,
        file.filename,
        file.path
      );
    }

    return this._mediaService.saveFile(org.id, file.filename, file.path);
  }

  @Post('/upload-from-url')
  async uploadsFromUrl(
    @GetOrgFromRequest() org: Organization,
    @Body() body: UploadDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    try {
      return await this._mediaService.uploadFromUrl(
        org.id,
        body.url,
        body.adjust
      );
    } catch (err) {
      // Validation failures keep this route's { msg } error shape
      if (err instanceof BadRequestException) {
        throw new HttpException({ msg: err.message }, 400);
      }
      throw err;
    }
  }

  @Get('/find-slot/:id')
  async findSlotIntegration(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id?: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return { date: await this._postsService.findFreeDateTime(org.id, id) };
  }

  @Get('/posts')
  async getPosts(
    @GetOrgFromRequest() org: Organization,
    @Query() query: GetPostsDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const posts = await this._postsService.getPosts(org.id, query);
    return {
      posts,
      // comments,
    };
  }

  @Post('/posts')
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  async createPost(
    @GetOrgFromRequest() org: Organization,
    @Body() rawBody: any
  ) {
    Sentry.metrics.count('public_api-request', 1);
    // anything that will be posted needs a human (DharaHIL); drafts don't
    const reason = publishReason([{ type: rawBody?.type }]);
    if (reason === null) {
      return this.runCreatePost(org, rawBody);
    }
    return publicApproval.run({
      action: 'public.posts.create',
      org: org.id,
      args: rawBody,
      reason,
      // an approved edit goes through every check below again
      execute: (args) => this.runCreatePost(org, args),
    });
  }

  private async runCreatePost(org: Organization, rawBody: any) {
    const body = await this._postsService.mapTypeToPost(
      {
        ...rawBody,
        // a date per channel is a dashboard feature, the public API keeps one
        // date for the whole request
        posts: Array.isArray(rawBody?.posts)
          ? rawBody.posts.map((post: any) => omit(post, 'date'))
          : rawBody?.posts,
      },
      org.id,
      rawBody?.type === 'draft' || true
    );
    body.type = rawBody.type;

    if (
      process.env.RESTRICT_UPLOAD_DOMAINS &&
      body.posts.some((p) =>
        p.value.some((a) =>
          a.image.some(
            (i) => i.path.indexOf(process.env.RESTRICT_UPLOAD_DOMAINS) === -1
          )
        )
      )
    ) {
      throw new HttpException(
        {
          msg: `All media must be uploaded through our upload API route and contain the domain: ${process.env.RESTRICT_UPLOAD_DOMAINS}`,
        },
        400
      );
    }

    // Server-side validation — same rules as the dashboard, surfaced as a
    // readable 400 (see PostValidationExceptionFilter).
    const validation = await this._postsService.validatePosts(
      org.id,
      body.posts
    );

    const fail = (item: (typeof validation)[number], error: string) => {
      throw new PostValidationException({
        provider: item.identifier,
        name: item.name,
        error,
      });
    };

    for (const item of validation) {
      if (item.emptyContent) {
        fail(
          item,
          'Your post should have at least one character or one image.'
        );
      }
    }

    if (body.type !== 'draft') {
      for (const item of validation) {
        if (!item.valid) {
          fail(item, item.settingsError || 'Please fix your settings');
        }
        if (item.errors !== true) {
          fail(item, item.errors as string);
        }
        if (item.tooLong) {
          fail(item, 'post is too long, please fix it');
        }
      }
    }

    const allowedCreationMethods = ['CLI', 'API'] as const;
    const creationMethod = allowedCreationMethods.includes(
      rawBody.creationMethod
    )
      ? (rawBody.creationMethod as 'CLI' | 'API')
      : 'API';

    return this._postsService.createPost(org.id, body, creationMethod);
  }

  @Delete('/posts/:id')
  async deletePost(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    // deleting cannot be undone: a human approves it (DharaHIL)
    return publicApproval.run({
      action: 'public.posts.delete',
      org: org.id,
      args: { id },
      reason: 'Deleting a post cannot be undone',
      execute: async (args) => {
        const getPostById = await this._postsService.getPost(org.id, args.id);
        return this._postsService.deletePost(org.id, getPostById.group);
      },
    });
  }

  @Delete('/posts/group/:group')
  deletePostByGroup(
    @GetOrgFromRequest() org: Organization,
    @Param('group') group: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return publicApproval.run({
      action: 'public.posts.deleteGroup',
      org: org.id,
      args: { group },
      reason: 'Deleting a post group cannot be undone',
      execute: (args) => this._postsService.deletePost(org.id, args.group),
    });
  }

  @Get('/is-connected')
  async getActiveIntegrations(@GetOrgFromRequest() org: Organization) {
    Sentry.metrics.count('public_api-request', 1);
    return { connected: true };
  }

  @Get('/media')
  async getMedia(
    @GetOrgFromRequest() org: Organization,
    @Query() query: GetMediaDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const { pages, results } = await this._mediaService.getMedia(
      org.id,
      query.page,
      query.search
    );

    return {
      pages,
      results: results.map((p) => ({
        id: p.id,
        name: p.name,
        originalName: p.originalName,
        path: p.path,
        createdAt: p.createdAt,
      })),
    };
  }

  @Get('/media/:id/status')
  async getMediaStatus(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._mediaService.getMediaUploadStatus(org.id, id);
  }

  // `user` is only known for OAuth app tokens; an API key belongs to the
  // whole organization
  @Get('/me')
  async getMe(
    @GetOrgFromRequest() org: Organization,
    @GetOAuthUserIdFromRequest() userId?: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const user = userId ? await this._usersService.getPersonal(userId) : null;

    return {
      organization: { id: org.id, name: org.name },
      user: user
        ? { id: user.id, name: user.name, picture: user.picture?.path || null }
        : null,
    };
  }

  @Get('/groups')
  async listGroups(@GetOrgFromRequest() org: Organization) {
    Sentry.metrics.count('public_api-request', 1);
    return (await this._integrationService.customers(org.id)).map(
      (customer) => ({
        id: customer.id,
        name: customer.name,
      })
    );
  }

  @Get('/integrations')
  async listIntegration(
    @GetOrgFromRequest() org: Organization,
    @Query('group') group?: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return (await this._integrationService.getIntegrationsList(org.id))
      .filter((integration) => !group || integration.customer?.id === group)
      .map((integration) => ({
        id: integration.id,
        name: integration.customName || integration.name,
        identifier: integration.providerIdentifier,
        picture: integration.picture,
        disabled: integration.disabled,
        profile: integration.profile,
        customer: integration.customer
          ? {
              id: integration.customer.id,
              name: integration.customer.name,
            }
          : undefined,
      }));
  }

  @Get('/social/:integration')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async getIntegrationUrl(
    @Param('integration') integration: string,
    @Query('refresh') refresh: string,
    @GetOrgFromRequest() org: Organization
  ) {
    Sentry.metrics.count('public_api-request', 1);
    if (
      !this._integrationManager
        .getAllowedSocialsIntegrations()
        .includes(integration)
    ) {
      throw new HttpException({ msg: 'Integration not allowed' }, 400);
    }

    // A provider migrated via MIGRATE_PROVIDERS reconnects through its target
    // provider's OAuth: the callback lands on the target and the channel is
    // migrated in place (see migrateIntegration).
    const migrateTo = refresh
      ? this._integrationManager.getMigrationTarget(integration)
      : undefined;

    const integrationProvider = this._integrationManager.getSocialIntegration(
      migrateTo || integration
    );

    if (integrationProvider.externalUrl) {
      throw new HttpException(
        {
          msg: 'This integration requires an external URL and is not supported via the public API',
        },
        400
      );
    }

    try {
      const { codeVerifier, state, url } =
        await integrationProvider.generateAuthUrl();

      if (refresh) {
        // The callback matches the channel by its provider account id, while
        // API callers only know the integration id.
        const existing = await this._integrationService.getIntegrationById(
          org.id,
          refresh
        );
        await ioRedis.set(
          `refresh:${state}`,
          existing?.internalId || refresh,
          'EX',
          3600
        );
      }

      await ioRedis.set(`organization:${state}`, org.id, 'EX', 3600);
      await ioRedis.set(`login:${state}`, codeVerifier, 'EX', 3600);

      return { url };
    } catch (err) {
      throw new HttpException({ msg: 'Failed to generate auth URL' }, 500);
    }
  }

  // Unlike /social/:integration, the URL is a Postiz page: the person reads
  // what connecting the channel means before they are sent to the platform.
  // The channel limit is checked again when they continue from that page
  @Post('/integrations/connect')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async createConnectLink(
    @GetOrgFromRequest() org: Organization,
    @Body() body: ConnectLinkDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    try {
      return await this._integrationService.createConnectLink(
        org.id,
        body.integration,
        body.redirectUrl
      );
    } catch (err) {
      // Refused integrations keep this route's { msg } error shape
      if (err instanceof HttpException) {
        throw new HttpException({ msg: err.message }, err.getStatus());
      }
      throw err;
    }
  }

  @Get('/users')
  @UseGuards(SuperAdminGuard)
  async listUsers(
    @GetOrgFromRequest() org: Organization,
    @Query('name') name: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const term = name?.trim();

    if (!term) {
      throw new HttpException({ msg: 'A search term is required' }, 400);
    }

    return this._usersService.getImpersonateUser(term);
  }

  @Get('/debug/posts/:id')
  @UseGuards(SuperAdminGuard)
  async getPostTimeline(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const timeline = await this._postsService.getPostTimeline(id, org.id);

    if (!timeline) {
      throw new HttpException({ msg: 'Post not found' }, 404);
    }

    return timeline;
  }

  @Get('/debug/account')
  @UseGuards(SuperAdminGuard)
  async getAccountOverview(@GetOrgFromRequest() org: Organization) {
    Sentry.metrics.count('public_api-request', 1);
    const account = await this._organizationService.getAccountOverview(org.id);

    if (!account) {
      throw new HttpException({ msg: 'Organization not found' }, 404);
    }

    return account;
  }

  @Get('/debug/channels')
  @UseGuards(SuperAdminGuard)
  async getChannelHealth(
    @GetOrgFromRequest() org: Organization,
    @GetIncludeDeletedFromRequest() includeDeleted: boolean
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._integrationService.getChannelHealth(org.id, includeDeleted);
  }

  @Get('/debug/activity')
  @UseGuards(SuperAdminGuard)
  async getOrgActivity(
    @GetOrgFromRequest() org: Organization,
    @GetIncludeDeletedFromRequest() includeDeleted: boolean,
    @Query() query: GetOrgActivityDto
  ) {
    Sentry.metrics.count('public_api-request', 1);

    const from = query.from ? dayjs(query.from) : dayjs().subtract(30, 'day');
    const to = query.to ? dayjs(query.to) : dayjs();

    return this._adminStatsService.getOrgActivity({
      organizationId: org.id,
      from: from.startOf('day').toDate(),
      to: to.endOf('day').toDate(),
      includeDeleted,
    });
  }

  @Post('/credits/reset')
  @UseGuards(SuperAdminGuard)
  async resetCredits(
    @GetOrgFromRequest() org: Organization,
    @Body() body: ResetCreditsDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const reset = await this._subscriptionService.resetCredits(
      org.id,
      body.type
    );

    if (!reset) {
      throw new HttpException({ msg: 'No subscription found' }, 404);
    }

    return reset;
  }

  @Get('/notifications')
  async getNotifications(
    @GetOrgFromRequest() org: Organization,
    @Query() query: GetNotificationsDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._notificationService.getNotificationsPaginated(
      org.id,
      query.page ?? 0
    );
  }

  @Post('/generate-video')
  generateVideo(
    @GetOrgFromRequest() org: Organization,
    @Body() body: VideoDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._mediaService.generateVideo(org, body);
  }

  @Post('/video/function')
  videoFunction(@Body() body: VideoFunctionDto) {
    Sentry.metrics.count('public_api-request', 1);
    return this._mediaService.videoFunction(
      body.identifier,
      body.functionName,
      body.params
    );
  }

  @Post('/clipping')
  startClipping(
    @GetOrgFromRequest() org: Organization,
    @Body() body: ClippingDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._clippingService.startClipping(org, body);
  }

  @Get('/clipping')
  getClippings(
    @GetOrgFromRequest() org: Organization,
    @Query('page') page: number
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._clippingService.getClippings(org.id, page);
  }

  @Get('/clipping/:id')
  getClipping(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    Sentry.metrics.count('public_api-request', 1);
    return this._clippingService.getClipping(org.id, id);
  }

  @Delete('/integrations/:id')
  async deleteChannel(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    // deleting a channel deletes its posts too: a human approves it (DharaHIL)
    return publicApproval.run({
      action: 'public.integrations.delete',
      org: org.id,
      args: { id },
      reason: 'Deleting a channel and its posts cannot be undone',
      execute: async (args) => {
        const isTherePosts = await this._integrationService.getPostsForChannel(
          org.id,
          args.id
        );
        if (isTherePosts.length) {
          for (const post of isTherePosts) {
            this._postsService.deletePost(org.id, post.group).catch(() => {});
          }
        }

        return this._integrationService.deleteChannel(org.id, args.id);
      },
    });
  }

  @Get('/integration-settings/:id')
  async getIntegrationSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const loadIntegration = await this._integrationService.getIntegrationById(
      org.id,
      id
    );

    if (!loadIntegration) {
      throw new HttpException({ msg: 'Integration not found' }, 404);
    }

    const verified =
      JSON.parse(loadIntegration.additionalSettings || '[]')?.find(
        (p: any) => p?.title === 'Verified'
      )?.value || false;

    const integration = socialIntegrationList.find(
      (p) => p.identifier === loadIntegration.providerIdentifier
    )!;

    if (!integration) {
      return {
        output: { rules: '', maxLength: 0, settings: {}, tools: [] as any[] },
      };
    }

    const maxLength = integration.maxLength(verified);
    const schemas = !integration.dto
      ? false
      : getValidationSchemas()[integration.dto.name];
    const tools = this._integrationManager.getAllTools();
    const rules = this._integrationManager.getAllRulesDescription();

    return {
      output: {
        rules: rules[integration.identifier],
        maxLength,
        settings: !schemas ? 'No additional settings required' : schemas,
        tools: tools[integration.identifier],
      },
    };
  }

  @Get('/posts/:id/missing')
  async getMissingContent(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._postsService.getMissingContent(org.id, id);
  }

  @Put('/posts/:id/settings')
  async updatePostSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdatePostSettingsDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    // only a scheduled (QUEUE) post's settings change what goes out, so only
    // those ask a human (DharaHIL); drafts are free, and anything else is
    // refused by the service at once instead of paging a person for nothing
    const snapshot = await this._postsService.approvalSnapshot(org.id, id);
    if (snapshot.state !== 'QUEUE') {
      return this._postsService.updatePostSettings(
        org.id,
        id,
        body.settings,
        'API'
      );
    }
    return publicApproval.run({
      action: 'public.posts.settings',
      org: org.id,
      args: { id, settings: body.settings, snapshot: snapshot.hash },
      reason: `Changing the settings of a scheduled post: "${snapshot.preview}"`,
      execute: async (args) => {
        await this.assertUnchanged(org.id, args.id, args.snapshot);
        return this._postsService.updatePostSettings(
          org.id,
          args.id,
          args.settings,
          'API'
        );
      },
    });
  }

  // The post must be exactly what the human approved: a change made since
  // (content, settings, date, channel, state) needs a new approval
  private async assertUnchanged(orgId: string, id: string, hash: string) {
    const now = await this._postsService.approvalSnapshot(orgId, id);
    if (now.hash !== hash) {
      throw new HttpException(
        {
          msg: 'The post changed after it was approved; send the request again to ask for a new approval',
        },
        409
      );
    }
  }

  @Put('/posts/:id/status')
  async changePostStatus(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: ChangePostStatusDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    // moving a draft to 'schedule' posts it: a human approves that (DharaHIL)
    if (body?.status === 'draft') {
      return this._postsService.changePostStatus(org.id, id, body.status);
    }
    // the human sees what will go out, and the hash ties the approval to it
    const snapshot = await this._postsService.approvalSnapshot(org.id, id);
    return publicApproval.run({
      action: 'public.posts.status',
      org: org.id,
      args: { id, status: body?.status, snapshot: snapshot.hash },
      reason: `Scheduling a draft to be posted: "${snapshot.preview}"`,
      execute: async (args) => {
        await this.assertUnchanged(org.id, args.id, args.snapshot);
        return this._postsService.changePostStatus(
          org.id,
          args.id,
          args.status
        );
      },
    });
  }

  @Put('/posts/:id/release-id')
  async updateReleaseId(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body('releaseId') releaseId: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    // the batch only links the posts in the dashboard
    const { batchId, ...post } = await this._postsService.updateReleaseId(
      org.id,
      id,
      releaseId
    );
    return post;
  }

  @Get('/analytics/:integration')
  async getAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Param('integration') integration: string,
    @Query('date') date: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._integrationService.checkAnalytics(org, integration, date);
  }

  @Get('/analytics/post/:postId')
  async getPostAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Param('postId') postId: string,
    @Query('date') date: string
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._postsService.checkPostAnalytics(org.id, postId, +date);
  }

  @Post('/integration-trigger/:id')
  async triggerIntegrationTool(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { methodName: string; data: Record<string, string> }
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const getIntegration = await this._integrationService.getIntegrationById(
      org.id,
      id
    );

    if (!getIntegration) {
      throw new HttpException({ msg: 'Integration not found' }, 404);
    }

    const integrationProvider = socialIntegrationList.find(
      (p) => p.identifier === getIntegration.providerIdentifier
    )!;

    if (!integrationProvider) {
      throw new HttpException({ msg: 'Integration provider not found' }, 404);
    }

    const tools = this._integrationManager.getAllTools();
    if (
      // @ts-ignore
      !tools[integrationProvider.identifier]?.some(
        (p: any) => p.methodName === body.methodName
      ) ||
      // @ts-ignore
      !integrationProvider[body.methodName]
    ) {
      throw new HttpException({ msg: 'Tool not found' }, 404);
    }

    while (true) {
      try {
        // @ts-ignore
        const result = await integrationProvider[body.methodName](
          getIntegration.token,
          body.data || {},
          getIntegration.internalId,
          getIntegration
        );

        return { output: result };
      } catch (err) {
        if (err instanceof RefreshToken) {
          const data = await this._refreshIntegrationService.refresh(
            getIntegration
          );

          if (!data) {
            await this._integrationService.disconnectChannel(
              org.id,
              getIntegration
            );
            throw new HttpException(
              { msg: 'Channel disconnected due to expired token' },
              401
            );
          }

          const { accessToken } = data;

          if (accessToken) {
            getIntegration.token = accessToken;

            if (integrationProvider.refreshWait) {
              await timer(10000);
            }

            continue;
          }
        }
        throw new HttpException({ msg: 'Unexpected error' }, 500);
      }
    }
  }
}
