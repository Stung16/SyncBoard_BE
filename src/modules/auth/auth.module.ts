import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { Env } from '../../config/env.validation.js';
import { REDIS, type RedisClient } from '../../infra/redis/redis.module.js';
import { UserModule } from '../user/user.module.js';
import { AuthController } from './controllers/auth.controller.js';
import { MeController } from './controllers/me.controller.js';
import { GoogleOAuthGuard } from './guards/google-oauth.guard.js';
import { SessionRepository } from './repositories/session.repository.js';
import { VerificationTokenRepository } from './repositories/verification-token.repository.js';
import { AuthService } from './services/auth.service.js';
import { SessionService } from './services/session.service.js';
import { VerificationService } from './services/verification.service.js';
import { GoogleStrategy } from './strategies/google.strategy.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';

@Module({
  imports: [
    UserModule,
    PassportModule.register({ session: false }), // stateless: không dùng express-session
    JwtModule.registerAsync({
      global: true, // gateway cũng dùng JwtService để xác thực socket
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: { expiresIn: config.get('JWT_ACCESS_TTL_SECONDS', { infer: true }) },
      }),
    }),
  ],
  controllers: [AuthController, MeController],
  providers: [
    AuthService,
    SessionService,
    VerificationService,
    SessionRepository,
    VerificationTokenRepository,
    // Strategy tự đăng ký với Passport khi được tạo. Thêm cách đăng nhập mới = thêm một strategy ở đây.
    JwtStrategy,
    {
      provide: GoogleStrategy,
      inject: [ConfigService, REDIS],
      useFactory: (config: ConfigService<Env, true>, redis: RedisClient) =>
        config.get('GOOGLE_CLIENT_ID', { infer: true }) ? new GoogleStrategy(config, redis) : null, // chưa cấu hình -> tắt
    },
    GoogleOAuthGuard,
  ],
})
export class AuthModule {}
