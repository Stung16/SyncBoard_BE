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
import { AppError } from '../../../common/errors/app-error.js';
import { registerSchema, type RegisterDto } from '../dto/register.dto.js';
import {
  verifyEmailSchema,
  type VerifyEmailDto,
} from '../dto/verify-email.dto.js';
import { GoogleOAuthGuard } from '../guards/google-oauth.guard.js';
import { AuthService } from '../services/auth.service.js';
import { SessionService } from '../services/session.service.js';
import type { OAuthProfile, RequestMeta } from '../types/auth.types.js';
import {
  REFRESH_COOKIE,
  refreshCookieOptions,
} from '../utils/refresh-cookie.js';
import { type LoginDto, loginSchema } from '../dto/login.dto.js';
import {
  type ForgotPasswordDto,
  forgotPasswordSchema,
  type ResetPasswordDto,
  resetPasswordSchema,
} from '../dto/password-reset.dto.js';
import {
  type ResendVerificationDto,
  resendVerificationSchema,
} from '../dto/resend-verification.dto.js';
import { hours, minutes, Throttle } from '@nestjs/throttler';

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
  @Throttle({ default: { limit: 5, ttl: hours(1) } }) // chống tạo tài khoản rác hàng loạt
  @Post('register')
  @HttpCode(201)
  async register(@Body({ schema: registerSchema }) dto: RegisterDto) {
    const { user } = await this.auth.register(dto);
    return { user, requiresEmailVerification: true };
  }

  @Public() // người bấm link trong mail chưa đăng nhập
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

  // Luôn 204 dù email có tồn tại / đã verify / đang chờ 60s hay không: response không tiết lộ gì.
  @Public()
  @Throttle({ default: { limit: 5, ttl: hours(1) } }) // mỗi lần gọi tốn một mail; 60s/user nằm trong service
  @Post('resend-verification')
  @HttpCode(204)
  async resendVerification(
    @Body({ schema: resendVerificationSchema })
    { email }: ResendVerificationDto,
  ) {
    await this.auth.resendVerification(email);
  }

  @Public()
  @Throttle({
    default: { limit: 5, ttl: minutes(1), blockDuration: minutes(15) },
  }) // quá 5 lần/phút -> khóa 15 phút
  @Post('login')
  @HttpCode(200)
  async login(
    @Body({ schema: loginSchema }) dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user } = await this.auth.login(
      dto,
      metaOf(req),
    );
    res.cookie(
      REFRESH_COOKIE,
      refreshToken,
      refreshCookieOptions(this.sessions.refreshTtlMs),
    );
    return { accessToken, user };
  }

  // Luôn 204 dù email có tài khoản hay không: response không tiết lộ gì (giống resend-verification).
  @Public()
  @Throttle({ default: { limit: 5, ttl: hours(1) } }) // mỗi lần gọi tốn một mail; 60s/user nằm trong service
  @Post('forgot-password')
  @HttpCode(204)
  async forgotPassword(
    @Body({ schema: forgotPasswordSchema }) { email }: ForgotPasswordDto,
  ) {
    await this.auth.forgotPassword(email);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: hours(1) } })
  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(
    @Body({ schema: resetPasswordSchema })
    { token, password }: ResetPasswordDto,
  ) {
    await this.auth.resetPassword(token, password);
  }

  // Public: access token đã hết hạn chính là lúc gọi refresh. Danh tính nằm trong cookie refresh (httpOnly).
  @Public()
  @Throttle({ default: { limit: 30, ttl: minutes(1) } }) // frontend tự gọi -> rộng tay hơn login
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token: unknown = req.cookies?.[REFRESH_COOKIE]; // cookie là dữ liệu từ ngoài vào: kiểm kiểu trước khi dùng
    if (typeof token !== 'string') throw new AppError('INVALID_REFRESH_TOKEN');
    const { accessToken, refreshToken } = await this.auth.refresh(
      token,
      metaOf(req),
    );
    res.cookie(
      REFRESH_COOKIE,
      refreshToken,
      refreshCookieOptions(this.sessions.refreshTtlMs),
    ); // đè cookie cũ
    return { accessToken };
  }

  // Public + luôn 204: phải đăng xuất được cả khi access token đã hết hạn hoặc cookie đã hỏng.
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token: unknown = req.cookies?.[REFRESH_COOKIE];
    if (typeof token === 'string') await this.sessions.revoke(token);
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(0)); // PHẢI cùng path lúc đặt, sai path trình duyệt không xóa
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
