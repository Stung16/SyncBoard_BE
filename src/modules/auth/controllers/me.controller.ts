import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { UserService } from '../../user/services/user.service.js';
import type { AuthUser } from '../types/auth.types.js';

@Controller('me')
export class MeController {
  constructor(private readonly users: UserService) {}

  // Token chỉ mang id; hồ sơ (tên, email, avatar...) luôn đọc mới từ DB -> đổi tên xong không phải chờ token mới.
  @Get()
  me(@CurrentUser() user: AuthUser) {
    return this.users.getById(user.id);
  }
}
