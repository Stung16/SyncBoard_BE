import { Module } from '@nestjs/common';
import { UserModule } from '../user/user.module.js';
import { AuthController } from './controllers/auth.controller.js';
import { MeController } from './controllers/me.controller.js';
import { SessionRepository } from './repositories/session.repository.js';
import { VerificationTokenRepository } from './repositories/verification-token.repository.js';
import { AuthService } from './services/auth.service.js';
import { SessionService } from './services/session.service.js';
import { VerificationService } from './services/verification.service.js';

// TODO(bạn code, bước A4): JwtModule.registerAsync({ global: true, ... }) và { provide: APP_GUARD, useClass: JwtAuthGuard }
@Module({
  imports: [UserModule],
  controllers: [AuthController, MeController],
  providers: [AuthService, SessionService, VerificationService, SessionRepository, VerificationTokenRepository],
})
export class AuthModule {}
