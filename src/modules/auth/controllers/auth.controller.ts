import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../../common/decorators/public.decorator.js';
import { registerSchema, type RegisterDto } from '../dto/register.dto.js';
import {
  verifyEmailSchema,
  type VerifyEmailDto,
} from '../dto/verify-email.dto.js';
import { GoogleOAuthGuard } from '../guards/google-oauth.guard.js';
import { AuthService } from '../services/auth.service.js';
import { SessionService } from '../services/session.service.js';
import type { OAuthProfile, RequestMeta } from '../types/auth.types.js';
import { REFRESH_COOKIE, refreshCookieOptions } from '../utils/refresh-cookie.js';

// ip + user-agent lưu vào sessions cho trang "thiết bị đang đăng nhập"
const metaOf = (req: Request): RequestMeta => ({
  ip: req.ip,
  userAgent: req.get('user-agent'),
});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(201)
  async register(
    @Body({ schema: registerSchema }) dto: RegisterDto,
    @Req() req: Request,
  ) {
    const { user } = await this.auth.register(dto);
    // res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(this.sessions.refreshTtlMs));
    return { user, requiresEmailVerification: true };
  }

  // TODO(bạn code): login, refresh, logout, verify-email, forgot/reset-password

  @Public()
  @Post('verify-email')
  @HttpCode(200) // POST mặc định 201; xác minh không tạo tài nguyên mới
  async verifyEmail(
    @Body({ schema: verifyEmailSchema }) { token }: VerifyEmailDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user } = await this.auth.verifyEmail(
      token,
      metaOf(req),
    );
    res.cookie(
      REFRESH_COOKIE,
      refreshToken,
      refreshCookieOptions(this.sessions.refreshTtlMs),
    );
    return { accessToken, user };
  }

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
