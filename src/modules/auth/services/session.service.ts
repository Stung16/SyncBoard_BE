import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '../../../common/errors/app-error.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { Env } from '../../../config/env.validation.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';
import { SessionRepository } from '../repositories/session.repository.js';
import type { RequestMeta } from '../types/auth.types.js';
import { randomToken, sha256 } from '../utils/token.util.js';

const DAY_MS = 86_400_000;
// 2 tab cùng refresh gần như cùng lúc: tab chậm gửi token vừa bị tab nhanh thay. Trong khoảng này không coi là bị đánh cắp.
const REUSE_GRACE_MS = 10_000;

@Injectable()
export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService, // chỉ để mở transaction; query nằm ở repository
  ) {}

  get refreshTtlMs() {
    return this.config.get('REFRESH_TTL_DAYS', { infer: true }) * DAY_MS;
  }

  // Tạo phiên mới, trả refresh token GỐC (DB chỉ giữ sha256). familyId mới = một lần đăng nhập trên một thiết bị.
  async create(userId: string, meta: RequestMeta): Promise<string> {
    return (await this.insert(userId, meta, randomUUID())).token;
  }

  // Đổi refresh token cũ lấy token mới trong CÙNG family; token cũ bị thu hồi và trỏ sang token mới (replacedById).
  async rotate(token: string, meta: RequestMeta) {
    const current = await this.sessions.findByTokenHash(sha256(token));
    if (!current) throw new AppError('INVALID_REFRESH_TOKEN');

    if (current.revokedAt) {
      // Đã bị thay từ lâu mà vẫn có người dùng -> token đã lộ: giết cả family (kẻ gian lẫn người thật phải đăng nhập lại).
      // Gọi NGOÀI transaction rồi mới throw, nếu không rollback sẽ hủy luôn việc thu hồi.
      const stolen =
        current.replacedById &&
        Date.now() - current.revokedAt.getTime() > REUSE_GRACE_MS;
      if (stolen) await this.sessions.revokeFamily(current.familyId);
      throw new AppError('INVALID_REFRESH_TOKEN'); // còn lại: đã logout, hoặc tab khác vừa xoay trước
    }
    if (current.expiresAt <= new Date())
      throw new AppError('INVALID_REFRESH_TOKEN');

    return this.prisma.$transaction(async (tx) => {
      const next = await this.insert(
        current.userId,
        meta,
        current.familyId,
        tx,
      );
      // count 0 = request khác vừa thu hồi trước mình -> ném lỗi để rollback session vừa tạo
      if (
        (await this.sessions.revokeActive(current.id, next.session.id, tx)) ===
        0
      )
        throw new AppError('INVALID_REFRESH_TOKEN');
      return { userId: current.userId, refreshToken: next.token };
    });
  }

  // Logout. Token lạ / đã thu hồi -> không làm gì (gọi nhiều lần vẫn an toàn).
  async revoke(token: string) {
    await this.sessions.revokeByTokenHash(sha256(token));
  }

  async revokeAll(userId: string, db?: Prisma.TransactionClient) {
    await this.sessions.revokeAllOfUser(userId, db);
  }

  private async insert(
    userId: string,
    meta: RequestMeta,
    familyId: string,
    db?: Prisma.TransactionClient,
  ) {
    const token = randomToken();
    const session = await this.sessions.create(
      {
        userId,
        familyId,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + this.refreshTtlMs),
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
      },
      db,
    );
    return { token, session };
  }
}
