import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'argon2';
import { AppError } from '../../../common/errors/app-error.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';
import { UserService } from '../../user/services/user.service.js';
import type { RegisterDto } from '../dto/register.dto.js';
import {
  USER_REGISTERED,
  type UserRegisteredEvent,
} from '../events/user-registered.event.js';
import type { RequestMeta, TokenPair } from '../types/auth.types.js';
import { SessionService } from './session.service.js';
import { VerificationService } from './verification.service.js';

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService, // chỉ để mở transaction; query nằm ở repository
    private readonly users: UserService,
    private readonly sessions: SessionService,
    private readonly verification: VerificationService,
    private readonly events: EventEmitter2,
    private readonly jwt: JwtService,
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

  // Điểm duy nhất phát token: register, login, Google callback đều kết thúc ở đây.
  async issueTokens(userId: string, meta: RequestMeta): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync({ sub: userId }); // hạn lấy từ JwtModule (JWT_ACCESS_TTL_SECONDS)
    const refreshToken = await this.sessions.create(userId, meta);
    return { accessToken, refreshToken };
  }
}
