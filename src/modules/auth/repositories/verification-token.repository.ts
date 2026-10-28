import { Injectable } from '@nestjs/common';
import type {
  Prisma
} from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

type Db = Prisma.TransactionClient;

// Chỉ chứa query bảng verification_tokens.
@Injectable()
export class VerificationTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    data: Prisma.VerificationTokenUncheckedCreateInput,
    db: Db = this.prisma,
  ) {
    return db.verificationToken.create({ data });
  }

  findByTokenHash(tokenHash: string, db: Db = this.prisma) {
    return db.verificationToken.findUnique({ where: { tokenHash } });
  }

  // Trả về số dòng đã cập nhật: 1 = mình là người dùng token, 0 = người khác đã dùng trước
  async markUsed(id: string, db: Db = this.prisma) {
    const { count } = await db.verificationToken.updateMany({
      where: { id, usedAt: null }, // ← điều kiện quan trọng nhất
      data: { usedAt: new Date() },
    });
    return count;
  }

}
