import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC } from '../decorators/public.decorator.js';

// Guard global (APP_GUARD trong AppModule): mặc định khóa mọi route HTTP, mở bằng @Public().
// Việc kiểm token do JwtStrategy ('jwt') làm.
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(ctx: ExecutionContext) {
    if (ctx.getType() !== 'http') return true; // tin socket: xác thực bằng middleware riêng
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    return super.canActivate(ctx);
  }

  // Mặc định Passport trả lỗi kèm lý do ("jwt expired"...). Trả 401 chung để không lộ thông tin.
  override handleRequest<TUser>(err: unknown, user: TUser | false): TUser {
    if (err || !user) throw new UnauthorizedException();
    return user;
  }
}
