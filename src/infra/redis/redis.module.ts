import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

export type RedisClient = ReturnType<typeof createClient>;
export const REDIS = Symbol('REDIS');

// Client dùng chung cho dữ liệu tạm cần chia sẻ giữa các server: presence, khóa mềm, rate limit, lock job.
// Pub/sub của Socket.IO dùng kết nối riêng trong SocketIoAdapter (một kết nối subscribe không chạy lệnh thường được).
@Injectable()
class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: RedisClient) {}

  async onModuleDestroy() {
    await this.redis.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const client = createClient({ url: config.getOrThrow<string>('REDIS_URL') });
        await client.connect(); // Redis chết thì app không khởi động, giống Prisma
        return client;
      },
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
