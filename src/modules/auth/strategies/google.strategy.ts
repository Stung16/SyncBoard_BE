import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { type Profile, Strategy } from 'passport-google-oauth20';
import type { Env } from '../../../config/env.validation.js';
import type { RedisClient } from '../../../infra/redis/redis.module.js';
import type { OAuthProfile } from '../types/auth.types.js';
import { RedisOAuthStateStore } from './redis-oauth-state.store.js';

// Strategy 'google': lo chuyển hướng sang Google, đổi code lấy token (PKCE), lấy profile.
// Không có @Injectable: AuthModule chỉ tạo strategy này khi GOOGLE_CLIENT_ID được cấu hình.
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService<Env, true>, redis: RedisClient) {
    super({
      clientID: config.get('GOOGLE_CLIENT_ID', { infer: true })!,
      clientSecret: config.get('GOOGLE_CLIENT_SECRET', { infer: true })!,
      callbackURL: config.get('GOOGLE_CALLBACK_URL', { infer: true }),
      scope: ['email', 'profile'],
      pkce: true,
      store: new RedisOAuthStateStore(redis, 'oauth:google:state') as never, // kiểu StateStore của @types quá hẹp so với API thật
    });
  }

  // Chỉ chuẩn hóa dữ liệu Google thành OAuthProfile. Tìm/tạo/liên kết user là việc của AuthService.
  validate(_accessToken: string, _refreshToken: string, profile: Profile): OAuthProfile {
    const email = profile.emails?.[0];
    return {
      provider: 'GOOGLE',
      providerAccountId: profile.id, // "sub": không đổi, khác với email
      email: email?.value.toLowerCase(),
      emailVerified: email?.verified === true, // chỉ liên kết với tài khoản sẵn có khi true
      displayName: profile.displayName,
      avatarUrl: profile.photos?.[0]?.value,
    };
  }
}
