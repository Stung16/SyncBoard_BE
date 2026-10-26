import { randomBytes } from 'node:crypto';
import type { RedisClient } from '../../../infra/redis/redis.module.js';

const STATE_TTL_SECONDS = 600; // người dùng có 10 phút để bấm đồng ý bên Google

type StoreCallback = (err: Error | null, handle?: string) => void;
type VerifyCallback = (err: Error | null, verifier?: string | false, info?: { message: string }) => void;

// State store cho passport-oauth2 lưu trong Redis thay vì express-session:
// app không dùng session và chạy nhiều node, callback có thể rơi vào node khác với node đã chuyển hướng.
// Lưu code_verifier của PKCE theo một handle ngẫu nhiên; handle chính là tham số `state` gửi sang Google (chống CSRF).
// passport-oauth2 chọn cách gọi theo SỐ THAM SỐ của hàm (Function.length): store 5 tham số = chế độ PKCE,
// verify 3 tham số. Đừng thêm/bớt tham số hay dùng tham số mặc định.
export class RedisOAuthStateStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly keyPrefix: string,
  ) {}

  store(_req: unknown, verifier: string, _state: unknown, _meta: unknown, cb: StoreCallback) {
    const handle = randomBytes(24).toString('base64url');
    this.redis
      .set(`${this.keyPrefix}:${handle}`, verifier, { expiration: { type: 'EX', value: STATE_TTL_SECONDS } })
      .then(() => cb(null, handle), (err: Error) => cb(err));
  }

  verify(_req: unknown, handle: string | undefined, cb: VerifyCallback) {
    if (!handle) return cb(null, false, { message: 'Missing OAuth state' });
    // GETDEL: đọc và xóa trong một lệnh -> mỗi state chỉ dùng được một lần (chống replay)
    this.redis
      .getDel(`${this.keyPrefix}:${handle}`)
      .then((verifier) => (verifier ? cb(null, verifier) : cb(null, false, { message: 'Invalid or expired OAuth state' })),
        (err: Error) => cb(err));
  }
}
