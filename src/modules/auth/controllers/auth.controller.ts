import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../../common/decorators/public.decorator.js';
import { registerSchema, type RegisterDto } from '../dto/register.dto.js';
import { GoogleOAuthGuard } from '../guards/google-oauth.guard.js';
import { AuthService } from '../services/auth.service.js';
import { SessionService } from '../services/session.service.js';
import type { OAuthProfile, RequestMeta } from '../types/auth.types.js';
import { REFRESH_COOKIE, refreshCookieOptions } from '../utils/refresh-cookie.js';

// ip + user-agent lưu vào sessions cho trang "thiết bị đang đăng nhập"
const metaOf = (req: Request): RequestMeta => ({ ip: req.ip, userAgent: req.get('user-agent') });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  // Access token trả trong body (frontend giữ trong bộ nhớ, gắn header Authorization).
  // Refresh token sống lâu hơn -> cookie httpOnly, JavaScript không đọc được.
  @Public()
  @Post('register')
  async register(
    @Body({ schema: registerSchema }) dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response, // passthrough: tự đặt cookie nhưng vẫn để Nest trả JSON
  ) {
    const { accessToken, refreshToken, user } = await this.auth.register(dto, metaOf(req));
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(this.sessions.refreshTtlMs));
    return { accessToken, user };
  }

  // TODO(bạn code): login, refresh, logout, verify-email, forgot/reset-password

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
    //                 (không đưa token lên URL; frontend gọi /api/v1/auth/refresh để lấy access token)
    return req.user; // tạm thời: xem dữ liệu Google trả về khi thử bằng tài khoản thật
  }
}
