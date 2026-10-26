import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from './config/env.validation.js';
import { PrismaModule } from './infra/database/prisma.module.js';
import { BoardModule } from './modules/board/board.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envSchema }),
    PrismaModule,
    HealthModule,
    BoardModule,
    RealtimeModule,
  ],
})
export class AppModule {}
