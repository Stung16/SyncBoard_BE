import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'argon2';
import { AppError } from '../../../common/errors/app-error.js';
import type { Env } from '../../../config/env.validation.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';
import { MailService } from '../../../infra/mail/mail.service.js';
import { UserService } from '../../user/services/user.service.js';
import type { RegisterDto } from '../dto/register.dto.js';
import type { RequestMeta, TokenPair } from '../types/auth.types.js';
import { SessionService } from './session.service.js';
import { VerificationService } from './verification.service.js';

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService, // chỉ để mở transaction; query nằm ở repository
    private readonly users: UserService,
    private readonly sessions: SessionService,
    private readonly verification: VerificationService,
    private readonly mail: MailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async register(dto: RegisterDto, meta: RequestMeta) {
    const passwordHash = await hash(dto.password); // argon2id; băm NGOÀI transaction để không giữ kết nối DB ~100ms

    // User và token xác minh cùng sống cùng chết: không có user "mồ côi" thiếu token, hay token trỏ vào user không tồn tại.
    const { user, verifyToken } = await this.prisma
      .$transaction(async (tx) => {
        const user = await this.users.create({ email: dto.email, passwordHash, displayName: dto.displayName }, tx);
        const verifyToken = await this.verification.issue(user.id, 'EMAIL_VERIFY', EMAIL_VERIFY_TTL_MS, tx);
        return { user, verifyToken };
      })
      // .catch((e: unknown) => {
      //   // Bắt lỗi unique thay vì findByEmail trước: 2 request cùng lúc đều thấy "chưa có" rồi cùng create, chỉ constraint mới chặn được.
      //   // users chỉ có 1 unique là email; token_hash là 32 byte ngẫu nhiên, không thể trùng -> P2002 ở đây = email trùng.
      //   if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError('EMAIL_TAKEN', 'email');
      //   throw e;
      // });

    // Link trỏ về frontend (frontend gọi POST /verify-email): trình quét email tự bấm link GET sẽ dùng mất token.
    const link = `${this.config.get('APP_URL', { infer: true })}/verify-email?token=${verifyToken}`;
    // Gửi mail lỗi không được làm hỏng đăng ký (user đã tạo xong); người dùng xin gửi lại sau.
    await this.mail.send(user.email, 'Xác minh email SyncBoard', link).catch((err: unknown) =>
      this.logger.warn(`Không gửi được mail xác minh cho user ${user.id}: ${String(err)}`),
    );

    return { ...(await this.issueTokens(user.id, meta)), user };
  }

  // Điểm duy nhất phát token: register, login, Google callback đều kết thúc ở đây.
  async issueTokens(userId: string, meta: RequestMeta): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync({ sub: userId }); // hạn lấy từ JwtModule (JWT_ACCESS_TTL_SECONDS)
    const refreshToken = await this.sessions.create(userId, meta);
    return { accessToken, refreshToken };
  }
}
