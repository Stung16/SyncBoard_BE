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
  create(
    data: { email: string; passwordHash: string | null; displayName: string },
    db: Db = this.prisma,
  ) {
    return db.user.create({ data, omit: { passwordHash: true } });
  }

  // Hồ sơ trả cho client: bỏ passwordHash, bỏ qua tài khoản đã xóa mềm.
  findById(id: string, db: Db = this.prisma) {
    return db.user.findUnique({
      where: { id, deletedAt: null },
      omit: { passwordHash: true },
    });
  }

  markEmailVerified(id: string, db: Db = this.prisma) {
    return db.user.update({
      where: { id, deletedAt: null },
      data: { emailVerifiedAt: new Date() },
      omit: { passwordHash: true },
    });
  }

  // Tài khoản đã xóa mềm -> không khớp -> P2025; service đổi thành AppError.
  setPassword(id: string, passwordHash: string, db: Db = this.prisma) {
    return db.user.update({
      where: { id, deletedAt: null },
      data: { passwordHash },
      omit: { passwordHash: true },
    });
  }
}
