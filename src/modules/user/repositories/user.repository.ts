import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

type Db = Prisma.TransactionClient; // PrismaService cũng khớp kiểu này

// Chỉ chứa query bảng users. Không logic nghiệp vụ, không ném HttpException.
@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Trả cả passwordHash: chỉ dùng nội bộ (login). Không trả thẳng ra client.
  findByEmail(email: string, db: Db = this.prisma) {
    return db.user.findUnique({ where: { email } });
  }

  // Trùng email -> Prisma ném P2002; service (AuthService.register) đổi thành AppError('EMAIL_TAKEN').
  create(data: { email: string; passwordHash: string | null; displayName: string }, db: Db = this.prisma) {
    return db.user.create({ data, omit: { passwordHash: true } });
  }
}
