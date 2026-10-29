import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import type { AuthUser } from '../../modules/auth/types/auth.types.js';
import { AppError } from '../errors/app-error.js';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  // APP_GUARD chạy cả cho sự kiện socket (vì thế JwtAuthGuard cũng có dòng này).
  // Socket giới hạn riêng bằng token bucket theo từng socket ở gateway: state theo socket được phép nằm local.
  protected override async shouldSkip(ctx: ExecutionContext) {
    return ctx.getType() !== 'http';
  }

  // Đã đăng nhập -> đếm theo user: cả văn phòng chung một IP không chặn lẫn nhau, đổi IP cũng không lách được.
  // Chưa đăng nhập -> theo IP; super.getTracker đã gộp IPv6 theo dải /64 (một người thường có cả dải).
  protected override async getTracker(req: Record<string, any>) {
    const user = (req as { user?: AuthUser }).user;
    return user ? `user:${user.id}` : `ip:${await super.getTracker(req)}`;
  }

  // Ném AppError thay ThrottlerException -> body cùng dạng mọi lỗi khác + có số giây chờ cho frontend.
  protected override async throwThrottlingException(
    _ctx: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw new AppError('RATE_LIMITED', undefined, {
      retryAfterSeconds: detail.timeToBlockExpire,
    });
  }
}
