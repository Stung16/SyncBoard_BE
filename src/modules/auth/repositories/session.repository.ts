import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service.js';

// Chỉ chứa query bảng sessions. Xoay vòng / phát hiện dùng lại là logic -> nằm ở SessionService.
@Injectable()
export class SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  // TODO(bạn code): create, findByTokenHash, rotate (transaction), revokeByTokenHash, revokeFamily, revokeAllOfUser...
}
