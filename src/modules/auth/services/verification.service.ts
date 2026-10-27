import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { VerificationTokenType } from '../../../generated/prisma/enums.js';
import { VerificationTokenRepository } from '../repositories/verification-token.repository.js';
import { randomToken, sha256 } from '../utils/token.util.js';

@Injectable()
export class VerificationService {
  constructor(private readonly tokens: VerificationTokenRepository) {}

  // Phát token dùng một lần (link trong email). Trả token GỐC để gửi mail; DB chỉ giữ sha256.
  async issue(userId: string, type: VerificationTokenType, ttlMs: number, db?: Prisma.TransactionClient) {
    const token = randomToken();
    await this.tokens.create({ userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) }, db);
    return token;
  }

  // TODO(bạn code, API verify-email/reset-password): consume(token, type, db) -> userId
}
