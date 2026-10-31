import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { VerificationTokenType } from '../../../generated/prisma/enums.js';
import { VerificationTokenRepository } from '../repositories/verification-token.repository.js';
import { randomToken, sha256 } from '../../../common/utils/token.util.js';
import { AppError, type ErrorCode } from '../../../common/errors/app-error.js';

// Mỗi loại token một câu báo lỗi; thêm loại mới vào enum mà quên dòng ở đây -> lỗi biên dịch.
const INVALID_TOKEN = {
  EMAIL_VERIFY: 'INVALID_VERIFY_TOKEN',
  PASSWORD_RESET: 'INVALID_RESET_TOKEN',
} as const satisfies Record<VerificationTokenType, ErrorCode>;

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

  // Thay token cũ bằng token mới: link trong các mail trước hết hiệu lực, mỗi user chỉ còn MỘT link dùng được.
  async reissue(
    userId: string,
    type: VerificationTokenType,
    ttlMs: number,
    db?: Prisma.TransactionClient,
  ) {
    await this.tokens.deleteUnused(userId, type, db);
    return this.issue(userId, type, ttlMs, db);
  }

  async consume(
    token: string,
    type: VerificationTokenType,
    db?: Prisma.TransactionClient,
  ): Promise<string> {
    const row = await this.tokens.findByTokenHash(sha256(token), db);
    if (!row || row.type !== type || row.usedAt || row.expiresAt <= new Date())
      throw new AppError(INVALID_TOKEN[type]);

    const count = await this.tokens.markUsed(row.id, db);
    if (count === 0) throw new AppError(INVALID_TOKEN[type]);
    return row.userId;
  }
}
