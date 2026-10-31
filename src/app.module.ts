import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { minutes, ThrottlerModule } from '@nestjs/throttler';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { envSchema } from './config/env.validation.js';
import { PrismaModule } from './infra/database/prisma.module.js';
import { MailModule } from './infra/mail/mail.module.js';
import {
  REDIS,
  RedisModule,
  type RedisClient,
} from './infra/redis/redis.module.js';
import { RedisThrottlerStorage } from './infra/redis/redis-throttler.storage.js';
import { SocketEmitterModule } from './infra/socket/socket-emitter.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BoardModule } from './modules/board/board.module.js';
import { CommentModule } from './modules/comment/comment.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { NotificationModule } from './modules/notification/notification.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { UserModule } from './modules/user/user.module.js';
import { AppThrottlerGuard } from './common/guards/app-throttler.guard.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envSchema }),
    EventEmitterModule.forRoot(), // global: inject EventEmitter2 ở đâu cũng được; quét mọi @OnEvent khi app khởi động
    ScheduleModule.forRoot(), // gọi đúng MỘT lần ở đây; job (@Interval/@Cron) khai báo ở module của nó
    PrismaModule,
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis: RedisClient) => ({
        throttlers: [{ name: 'default', limit: 120, ttl: minutes(1) }],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
    SocketEmitterModule,
    MailModule,
    HealthModule,
    UserModule,
    AuthModule,
    BoardModule,
    RealtimeModule,
    NotificationModule,
    CommentModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AppThrottlerGuard }, // SAU JwtAuthGuard: req.user đã có -> đếm theo user được
  ],
})
export class AppModule {}
