import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Env } from '../../../config/env.validation.js';
import type { AuthUser, JwtPayload } from '../types/auth.types.js';

// Strategy 'jwt': đọc "Authorization: Bearer <token>", kiểm chữ ký + hạn, trả AuthUser -> thành req.user.
// Socket không đi qua Passport: middleware của gateway gọi thẳng JwtService.verifyAsync với cùng secret.
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService<Env, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('JWT_ACCESS_SECRET', { infer: true }),
      algorithms: ['HS256'], // chặn token ký bằng thuật toán khác (kể cả "none")
      ignoreExpiration: false,
    });
  }

  validate(payload: JwtPayload): AuthUser {
    return { id: payload.sub };
  }
}
