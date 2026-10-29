import {
  BadRequestException,
  INestApplication,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import {
  AllExceptionsFilter,
  type ApiError,
} from './common/filters/all-exceptions.filter.js';
import { API_PREFIX } from './config/api-prefix.js';
import { requestLogger } from './common/middleware/request-logger.js';
import type { Env } from './config/env.validation.js';
import { SocketIoAdapter } from './infra/socket/socket-io.adapter.js';

// Dùng chung cho main.ts và e2e, để test chạy đúng cấu hình production.
export async function setupApp(app: INestApplication) {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const corsOrigin = config.get('CORS_ORIGIN', { infer: true }).split(',');
  // Express lấy IP từ X-Forwarded-For, bỏ đi đúng N proxy tin cậy. Sai số này = rate limit theo IP vô dụng hoặc bị lách.
  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', config.get('TRUST_PROXY', { infer: true }));

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } })); // frontend khác origin vẫn tải được ảnh (GĐ2)
  app.enableCors({
    origin: corsOrigin,
    credentials: true,
    exposedHeaders: [
      'Retry-After',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
  }); // credentials: gửi kèm cookie refresh token
  app.use(cookieParser());
  app.use(requestLogger);
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health'] }); // /health giữ ngắn cho load balancer

  // Mỗi issue Zod thành một lỗi có `field` riêng (mặc định Nest chỉ trả mảng chuỗi "password: Too small...").
  // Pipe này chạy cho cả HTTP lẫn Socket.IO, nên client WS cũng nhận cùng dạng { errors }.
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      exceptionFactory: (issues) =>
        new BadRequestException({
          errors: issues.map((i): ApiError => ({
            code: 'VALIDATION_ERROR',
            message: i.message,
            field:
              i.path
                ?.map((p) => String(typeof p === 'object' ? p.key : p))
                .join('.') || null, // "items.0.name"
          })),
        }),
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const adapter = new SocketIoAdapter(
    app,
    corsOrigin,
    config.get('REDIS_URL', { infer: true }),
  );
  await adapter.connectToRedis();
  app.useWebSocketAdapter(adapter);

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle('SyncBoard API')
      .setVersion('1')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, () =>
      SwaggerModule.createDocument(app, doc),
    ); // /api/v1/docs
  }

  app.enableShutdownHooks();
  return config;
}
