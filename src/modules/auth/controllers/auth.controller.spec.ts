import { Test, TestingModule } from '@nestjs/testing';
import { GoogleOAuthGuard } from '../guards/google-oauth.guard.js';
import { AuthService } from '../services/auth.service.js';
import { SessionService } from '../services/session.service.js';
import { AuthController } from './auth.controller.js';

// Hành vi thật của các route (cookie, status, validate) được kiểm ở test/auth.e2e-spec.ts.
describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: SessionService, useValue: {} },
      ],
    })
      .overrideGuard(GoogleOAuthGuard) // unit test controller: không cần Passport/Config thật
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
