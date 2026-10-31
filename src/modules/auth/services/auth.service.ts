import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from 'argon2';
import { AppError } from '../../../common/errors/app-error.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';
import { REDIS, type RedisClient } from '../../../infra/redis/redis.module.js';
import { AuditService } from '../../audit/services/audit.service.js';
import { UserService } from '../../user/services/user.service.js';
import type { RegisterDto } from '../dto/register.dto.js';
import {
  USER_REGISTERED,
  type UserRegisteredEvent,
} from '../events/user-registered.event.js';
import {
  EMAIL_VERIFICATION_REQUESTED,
  type EmailVerificationRequestedEvent,
} from '../events/email-verification-requested.event.js';
import {
  PASSWORD_RESET_REQUESTED,
  type PasswordResetRequestedEvent,
} from '../events/password-reset-requested.event.js';
import type { RequestMeta, TokenPair } from '../types/auth.types.js';
import { SessionService } from './session.service.js';
import { VerificationService } from './verification.service.js';
import { LoginDto } from '../dto/login.dto.js';

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // ngắn hơn verify: link này đổi được mật khẩu
const MAIL_COOLDOWN_SECONDS = 60;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService, // chỉ để mở transaction; query nằm ở repository
    private readonly users: UserService,
    private readonly sessions: SessionService,
    private readonly verification: VerificationService,
    private readonly events: EventEmitter2,
    private readonly jwt: JwtService,
    @Inject(REDIS) private readonly redis: RedisClient,
    private readonly audit: AuditService,
  ) {}

  async register(dto: RegisterDto) {
    const passwordHash = await hash(dto.password); // argon2id; băm NGOÀI transaction để không giữ kết nối DB ~100ms

    // User và token xác minh cùng sống cùng chết: không có user "mồ côi" thiếu token, hay token trỏ vào user không tồn tại.
    const { user, verifyToken } = await this.prisma
      .$transaction(async (tx) => {
        const user = await this.users.create(
          { email: dto.email, passwordHash, displayName: dto.displayName },
          tx,
        );
        const verifyToken = await this.verification.issue(
          user.id,
          'EMAIL_VERIFY',
          EMAIL_VERIFY_TTL_MS,
          tx,
        );
        return { user, verifyToken };
      })
      .catch((e: unknown) => {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        )
          throw new AppError('EMAIL_TAKEN', 'email');
        throw e;
      });

    await this.audit.record({ action: 'auth.register', actorId: user.id });
    this.events.emit(USER_REGISTERED, {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      verifyToken,
    } satisfies UserRegisteredEvent);

    return { user };
  }

  async verifyEmail(token: string, meta: RequestMeta) {
    const user = await this.prisma
      .$transaction(async (tx) => {
        const userId = await this.verification.consume(
          token,
          'EMAIL_VERIFY',
          tx,
        );
        return this.users.markEmailVerified(userId, tx);
      })
      .catch((e: unknown) => {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2025'
        )
          throw new AppError('INVALID_VERIFY_TOKEN');
        throw e;
      });
    return { ...(await this.issueTokens(user.id, meta)), user };
  }

  async login({ email, password }: LoginDto, meta: RequestMeta) {
    const user = await this.users.findByEmail(email);
    if (
      !user ||
      user.deletedAt ||
      !user.passwordHash ||
      !(await verify(user.passwordHash, password))
    ) {
      // Dò mật khẩu hàng loạt hiện ra ở đây (cùng email, nhiều IP / cùng IP, nhiều email). email đã chuẩn hóa ở DTO.
      await this.audit.record({ action: 'auth.login_failed', actorId: user?.id ?? null, metadata: { email } });
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (!user.emailVerifiedAt) throw new AppError('EMAIL_NOT_VERIFIED');
    const { passwordHash: _passwordHash, ...safeUser } = user;
    return { ...(await this.issueTokens(user.id, meta)), user: safeUser };
  }

  // Mọi nhánh "không làm gì" đều trả về im lặng -> controller luôn 204: không dò được email nào có trong hệ thống.
  async resendVerification(email: string) {
    const user = await this.users.findByEmail(email);
    if (!user || user.deletedAt || user.emailVerifiedAt) return; // đã verify thì không phát token mới -> không ghi đè emailVerifiedAt

    if (!(await this.passCooldown(`resend-verify:${user.id}`))) return;

    const verifyToken = await this.prisma.$transaction((tx) =>
      this.verification.reissue(
        user.id,
        'EMAIL_VERIFY',
        EMAIL_VERIFY_TTL_MS,
        tx,
      ),
    );

    this.events.emit(EMAIL_VERIFICATION_REQUESTED, {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      verifyToken,
    } satisfies EmailVerificationRequestedEvent);
  }

  // Cùng nguyên tắc resend: luôn im lặng -> controller luôn 204, không dò được email nào có tài khoản.
  // Tài khoản chỉ đăng nhập Google (chưa có mật khẩu) cũng nhận được: đặt mật khẩu = thêm cách đăng nhập.
  async forgotPassword(email: string) {
    const user = await this.users.findByEmail(email);
    if (!user || user.deletedAt) return;
    if (!(await this.passCooldown(`forgot-password:${user.id}`))) return;

    const resetToken = await this.prisma.$transaction((tx) =>
      this.verification.reissue(
        user.id,
        'PASSWORD_RESET',
        PASSWORD_RESET_TTL_MS,
        tx,
      ),
    );

    this.events.emit(PASSWORD_RESET_REQUESTED, {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      resetToken,
    } satisfies PasswordResetRequestedEvent);
  }

  // Không tự đăng nhập sau khi đặt lại: người dùng đăng nhập lại bằng mật khẩu mới.
  async resetPassword(token: string, password: string) {
    const passwordHash = await hash(password); // băm NGOÀI transaction, như register

    const userId = await this.prisma
      .$transaction(async (tx) => {
        const userId = await this.verification.consume(
          token,
          'PASSWORD_RESET',
          tx,
        );
        const user = await this.users.setPassword(userId, passwordHash, tx);
        // Mở được link trong mail = chứng minh sở hữu email; không thì đặt mật khẩu xong vẫn bị EMAIL_NOT_VERIFIED.
        if (!user.emailVerifiedAt)
          await this.users.markEmailVerified(userId, tx);
        // Mật khẩu cũ có thể đã lộ: đá mọi thiết bị ra (refresh token cũ hết dùng được).
        await this.sessions.revokeAll(userId, tx);
        return userId;
      })
      .catch((e: unknown) => {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2025'
        )
          throw new AppError('INVALID_RESET_TOKEN'); // tài khoản đã xóa mềm
        throw e;
      });
    await this.audit.record({ action: 'auth.password_reset', actorId: userId });
  }

  // 1 lần / 60s / key. Redis chứ không phải Map: nhiều node thì mỗi Map đếm riêng. NX = chỉ đặt khi chưa có key.
  private async passCooldown(key: string) {
    const ok = await this.redis.set(key, '1', {
      expiration: { type: 'EX', value: MAIL_COOLDOWN_SECONDS },
      condition: 'NX',
    });
    return ok !== null;
  }

  // Access token mới + refresh token mới (token cũ bị thu hồi trong SessionService.rotate).
  async refresh(token: string, meta: RequestMeta): Promise<TokenPair> {
    const { userId, refreshToken } = await this.sessions.rotate(token, meta);
    return {
      accessToken: await this.jwt.signAsync({ sub: userId }),
      refreshToken,
    };
  }

  // Điểm duy nhất phát token: register, login, Google callback đều kết thúc ở đây.
  async issueTokens(userId: string, meta: RequestMeta): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync({ sub: userId }); // hạn lấy từ JwtModule (JWT_ACCESS_TTL_SECONDS)
    const refreshToken = await this.sessions.create(userId, meta);
    await this.audit.record({ action: 'auth.login', actorId: userId }); // mọi cách đăng nhập (mật khẩu, xác minh email, Google) đều qua đây
    return { accessToken, refreshToken };
  }
}
