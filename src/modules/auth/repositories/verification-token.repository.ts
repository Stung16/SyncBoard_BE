import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

type Db = Prisma.TransactionClient;

// Chỉ chứa query bảng verification_tokens.
@Injectable()
export class VerificationTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.VerificationTokenUncheckedCreateInput, db: Db = this.prisma) {
    return db.verificationToken.create({ data });
  }

  // TODO(bạn code, API verify-email/reset-password): findByTokenHash, markUsed
}
