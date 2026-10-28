import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { VerificationTokenType } from '../../../generated/prisma/enums.js';
import { VerificationTokenRepository } from '../repositories/verification-token.repository.js';
import { randomToken, sha256 } from '../utils/token.util.js';
import { AppError } from '../../../common/errors/app-error.js';

@Injectable()
export class VerificationService {
  constructor(private readonly tokens: VerificationTokenRepository) {}

  // Phát token dùng một lần (link trong email). Trả token GỐC để gửi mail; DB chỉ giữ sha256.
  async issue(
    userId: string,
    type: VerificationTokenType,
    ttlMs: number,
    db?: Prisma.TransactionClient,
  ) {
    const token = randomToken();
    await this.tokens.create(
      {
        userId,
        type,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + ttlMs),
      },
      db,
    );
    return token;
  }

  async consume(
    token: string,
    type: VerificationTokenType,
    db?: Prisma.TransactionClient,
  ): Promise<string> {
    const row = await this.tokens.findByTokenHash(sha256(token), db);
    // TODO: nếu !row || row.type !== type || row.usedAt || row.expiresAt <= new Date()
    if (!row || row.type !== type || row.usedAt || row.expiresAt <= new Date())
      throw new AppError('INVALID_VERIFY_TOKEN');

    const count = await this.tokens.markUsed(row.id, db);
    if (count === 0) throw new AppError('INVALID_VERIFY_TOKEN');
    return row.userId;
  }

}
