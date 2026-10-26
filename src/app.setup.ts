import { INestApplication, StandardSchemaValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter.js';
import { requestLogger } from './common/middleware/request-logger.js';
import type { Env } from './config/env.validation.js';
import { SocketIoAdapter } from './infra/socket/socket-io.adapter.js';

// Dùng chung cho main.ts và e2e, để test chạy đúng cấu hình production.
export async function setupApp(app: INestApplication) {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const corsOrigin = config.get('CORS_ORIGIN', { infer: true }).split(',');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } })); // frontend khác origin vẫn tải được ảnh (GĐ2)
  app.enableCors({ origin: corsOrigin, credentials: true }); // credentials: gửi kèm cookie refresh token
  app.use(cookieParser());
  app.use(requestLogger);
  app.setGlobalPrefix('api', { exclude: ['health'] }); // /health giữ ngắn cho load balancer

  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.useGlobalFilters(new PrismaExceptionFilter(app.get(HttpAdapterHost).httpAdapter));

  const adapter = new SocketIoAdapter(app, corsOrigin, config.get('REDIS_URL', { infer: true }));
  await adapter.connectToRedis();
  app.useWebSocketAdapter(adapter);

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const doc = new DocumentBuilder().setTitle('SyncBoard API').setVersion('1').addBearerAuth().build();
    SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, doc)); // /api/docs
  }

  app.enableShutdownHooks();
  return config;
}
