import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../../common/decorators/public.decorator.js';
import { GoogleOAuthGuard } from '../guards/google-oauth.guard.js';
import type { OAuthProfile } from '../types/auth.types.js';

@Controller('auth')
export class AuthController {
  // TODO(bạn code): register, login, refresh, logout, verify-email, forgot/reset-password

  @Public()
  @UseGuards(GoogleOAuthGuard)
  @Get('google')
  google() {
    // Không bao giờ chạy: guard đã chuyển hướng (302) sang trang đăng nhập Google.
  }

  @Public()
  @UseGuards(GoogleOAuthGuard)
  @Get('google/callback')
  googleCallback(@Req() req: Request & { user: OAuthProfile }) {
    // TODO(bạn code): const user = await this.auth.oauthLogin(req.user)  // tìm/tạo/liên kết theo (provider, providerAccountId)
    //                 issueTokens -> đặt cookie refresh -> res.redirect(`${APP_URL}/auth/callback`)
    //                 (không đưa token lên URL; frontend gọi /api/auth/refresh để lấy access token)
    return req.user; // tạm thời: xem dữ liệu Google trả về khi thử bằng tài khoản thật
  }
}
