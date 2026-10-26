import { Controller, Get, Inject } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { REDIS, type RedisClient } from '../../infra/redis/redis.module.js';
import { Public } from '../../common/decorators/public.decorator.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: RedisClient,
  ) {}

  @Get()
  async check() {
    // DB hoặc Redis chết thì ném lỗi -> 500, load balancer ngừng gửi request vào server này
    await Promise.all([this.prisma.$queryRaw`SELECT 1`, this.redis.ping()]);
    return { status: 'ok' };
  }
}
