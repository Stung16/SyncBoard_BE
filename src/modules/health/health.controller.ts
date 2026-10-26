import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../../infra/database/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    await this.prisma.$queryRaw`SELECT 1`; // DB chết thì ném lỗi -> 500
    return { status: 'ok' };
  }
}
