import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

type Db = Prisma.TransactionClient;

// Chỉ chứa query bảng sessions. Xoay vòng / phát hiện dùng lại là logic -> nằm ở SessionService.
@Injectable()
export class SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.SessionUncheckedCreateInput, db: Db = this.prisma) {
    return db.session.create({ data });
  }

  // TODO(bạn code, API refresh/logout): findByTokenHash, revoke, revokeByTokenHash, revokeFamily, revokeAllOfUser
}
