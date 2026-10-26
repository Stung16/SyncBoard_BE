import { INestApplication, StandardSchemaValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './config/env.validation.js';
import { SocketIoAdapter } from './infra/socket/socket-io.adapter.js';

// Dùng chung cho main.ts và e2e, để test chạy đúng cấu hình production.
export function setupApp(app: INestApplication) {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.useWebSocketAdapter(new SocketIoAdapter(app, config.get('CORS_ORIGIN', { infer: true }).split(',')));
  app.enableShutdownHooks();
  return config;
}
