import { Test, TestingModule } from '@nestjs/testing';
import { GoogleOAuthGuard } from '../guards/google-oauth.guard.js';
import { AuthController } from './auth.controller.js';

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
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
