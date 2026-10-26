import { Module } from '@nestjs/common';
import { UserRepository } from './repositories/user.repository.js';
import { UserService } from './services/user.service.js';

@Module({
  providers: [UserService, UserRepository],
  exports: [UserService], // module khác dùng service, không chạm thẳng repository của user
})
export class UserModule {}
