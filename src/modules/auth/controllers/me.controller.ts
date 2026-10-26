import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../types/auth.types.js';

@Controller('me')
export class MeController {
  @Get()
  me(@CurrentUser() user: AuthUser) {
    return user; 
  }
}
