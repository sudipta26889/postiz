import { initializeSentry } from '@gitroom/nestjs-libraries/sentry/initialize.sentry';
initializeSentry('backend', true);
import compression from 'compression';

import { loadSwagger } from '@gitroom/helpers/swagger/load.swagger';
import { json } from 'express';
import { Runtime } from '@temporalio/worker';
Runtime.install({ shutdownSignals: [] });

process.env.TZ = 'UTC';

import cookieParser from 'cookie-parser';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

import { SubscriptionExceptionFilter } from '@gitroom/backend/services/auth/permissions/subscription.exception';
import { PostValidationExceptionFilter } from '@gitroom/backend/api/routes/posts.validation.exception';
import { HttpExceptionFilter } from '@gitroom/nestjs-libraries/services/exception.filter';
import { ConfigurationChecker } from '@gitroom/helpers/configuration/configuration.checker';
import { startMcp } from '@gitroom/nestjs-libraries/chat/start.mcp';

async function start() {
  const defaultCors = {
      ...(!process.env.NOT_SECURED ? { credentials: true } : {}),
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'auth',
        'showorg',
        'impersonate',
        'x-postiz-org',
        'x-postiz-include-deleted',
        'x-copilotkit-runtime-client-gql-version',
      ],
      exposedHeaders: [
        'reload',
        'onboarding',
        'activate',
        'x-copilotkit-runtime-client-gql-version',
        ...(process.env.NOT_SECURED ? ['auth', 'showorg', 'impersonate'] : []),
      ],
      origin: [
        process.env.FRONTEND_URL,
        'http://localhost:6274',
        ...(process.env.MAIN_URL ? [process.env.MAIN_URL] : []),
        // Optional: the Canva app calls the public API from its iframe origin
        // (browsers send it lowercase, e.g. https://app-aabbcc.canva-apps.com)
        ...(process.env.CANVA_APP_ORIGIN
          ? [
              process.env.CANVA_APP_ORIGIN.trim()
                .replace(/\/+$/, '')
                .toLowerCase(),
            ]
          : []),
      ],
    };

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    // The OAuth token and registration endpoints are called by browser-based
    // MCP clients from any origin and never use cookies: `*` without
    // credentials there; every other route keeps the allow-list above
    cors: (req: any, callback: (err: Error | null, options?: any) => void) =>
      callback(
        null,
        /^\/oauth\/(token|register)\/?(\?|$)/.test(req.url || '')
          ? {
              origin: '*',
              credentials: false,
              allowedHeaders: ['Content-Type', 'Authorization'],
            }
          : defaultCors
      ),
  });

  // RFC 6749 5.1: no token response may be cached. Set before validation,
  // so a 400 from the body validation carries it too
  app.use('/oauth/token', (req: any, res: any, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  await startMcp(app);

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
    })
  );

  app.use(['/copilot/{*splat}', '/posts'], (req: any, res: any, next: any) => {
    json({ limit: '50mb' })(req, res, next);
  });

  app.use(cookieParser());
  app.use(compression());
  app.useGlobalFilters(new SubscriptionExceptionFilter());
  app.useGlobalFilters(new PostValidationExceptionFilter());
  app.useGlobalFilters(new HttpExceptionFilter());

  loadSwagger(app);

  const port = process.env.PORT || 3000;

  try {
    await app.listen(port);

    // Keep idle connections open longer than the load balancer does (AWS ALB
    // idle timeout is 900s). Node's default of 5s lets the backend close a
    // connection the ALB is about to reuse, which the ALB returns as a 502.
    const server = app.getHttpServer();
    server.keepAliveTimeout = 905_000;
    server.headersTimeout = 906_000;

    console.log('Backend started successfully on port ' + port);

    checkConfiguration(); // Do this last, so that users will see obvious issues at the end of the startup log without having to scroll up.

    Logger.log(`🚀 Backend is running on: http://localhost:${port}`);
  } catch (e) {
    Logger.error(`Backend failed to start on port ${port}`, e);
  }
}

function checkConfiguration() {
  const checker = new ConfigurationChecker();
  checker.readEnvFromProcess();
  checker.check();

  if (checker.hasIssues()) {
    for (const issue of checker.getIssues()) {
      Logger.warn(issue, 'Configuration issue');
    }

    Logger.warn('Configuration issues found: ' + checker.getIssuesCount());
  } else {
    Logger.log('Configuration check completed without any issues');
  }
}

start();
