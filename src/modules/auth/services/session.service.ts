import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.validation.js';
import { SessionRepository } from '../repositories/session.repository.js';
import type { RequestMeta } from '../types/auth.types.js';
import { randomToken, sha256 } from '../utils/token.util.js';

const DAY_MS = 86_400_000;

@Injectable()
export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly config: ConfigService<Env, true>,
  ) {}

  get refreshTtlMs() {
    return this.config.get('REFRESH_TTL_DAYS', { infer: true }) * DAY_MS;
  }

  // Tạo phiên mới, trả refresh token GỐC (DB chỉ giữ sha256). familyId mới = một lần đăng nhập trên một thiết bị.
  async create(userId: string, meta: RequestMeta, familyId: string = randomUUID()): Promise<string> {
    const token = randomToken();
    await this.sessions.create({
      userId,
      familyId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + this.refreshTtlMs),
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    });
    return token;
  }

  // TODO(bạn code, API refresh/logout): rotate (xoay vòng + phát hiện dùng lại), revoke, revokeAll
}
