import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service.js';

// Chỉ chứa query bảng verification_tokens.
@Injectable()
export class VerificationTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  // TODO(bạn code): create, findByTokenHash, markUsed...
}
