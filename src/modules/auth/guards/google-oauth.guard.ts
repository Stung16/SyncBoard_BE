import { ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import type { Env } from '../../../config/env.validation.js';

// Dùng cho cả /auth/google (chuyển hướng sang Google) và /auth/google/callback (Google gọi về).
@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  override canActivate(ctx: ExecutionContext) {
    if (!this.config.get('GOOGLE_CLIENT_ID', { infer: true })) throw new NotFoundException(); // chưa cấu hình Google
    return super.canActivate(ctx);
  }
}
