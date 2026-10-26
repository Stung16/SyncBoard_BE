import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { envSchema } from './config/env.validation.js';
import { PrismaModule } from './infra/database/prisma.module.js';
import { MailModule } from './infra/mail/mail.module.js';
import { RedisModule } from './infra/redis/redis.module.js';
import { SocketEmitterModule } from './infra/socket/socket-emitter.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BoardModule } from './modules/board/board.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { UserModule } from './modules/user/user.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envSchema }),
    PrismaModule,
    RedisModule,
    SocketEmitterModule,
    MailModule,
    HealthModule,
    UserModule,
    AuthModule,
    BoardModule,
    RealtimeModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
