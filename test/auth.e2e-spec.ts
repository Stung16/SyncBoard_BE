import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { PrismaService } from '../src/infra/database/prisma.service.js';
import { MailService } from '../src/infra/mail/mail.service.js';
import { REDIS, type RedisClient } from '../src/infra/redis/redis.module.js';
import { sha256 } from '../src/modules/auth/utils/token.util.js';

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await setupApp(app);
    await app.init();
    jwt = app.get(JwtService);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  // Mọi request của supertest cùng một IP và bộ đếm sống qua các lần chạy -> xóa để test không ăn giới hạn của nhau
  beforeEach(async () => {
    const redis = app.get<RedisClient>(REDIS);
    const keys = await redis.keys('rl:*'); // KEYS quét toàn bộ Redis: chỉ dùng trong test
    if (keys.length) await redis.del(keys);
  });

  describe('Rate limit (throttler + Redis)', () => {
    it('login: 5 lần/phút qua, lần 6 -> 429 RATE_LIMITED + Retry-After; vẫn bị khóa ở lần sau', async () => {
      const login = () =>
        request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: `${randomUUID()}@e2e.test`, password: 'whatever-1' });
      for (let i = 0; i < 5; i++) await login().expect(401);

      const res = await login().expect(429);
      expect(res.headers['retry-after']).toBe('900'); // blockDuration 15 phút
      expect(res.body).toEqual({
        errors: [{ code: 'RATE_LIMITED', message: expect.any(String), field: null, details: { retryAfterSeconds: 900 } }],
      });
      await login().expect(429);
    });

    it('/health không bị giới hạn; route thường có header X-RateLimit-*', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await request(app.getHttpServer()).get('/health').expect(200);
        expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      }
      const me = await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${await jwt.signAsync({ sub: randomUUID() })}`);
      expect(me.headers['x-ratelimit-limit']).toBe('120');
    });
  });

  describe('POST /api/v1/auth/register', () => {
    const newEmail = () => `${randomUUID()}@e2e.test`;
    const body = (email = newEmail()) => ({ email, password: 'correct-horse-1', displayName: 'An' });

    it('201: chỉ trả user + requiresEmailVerification, KHÔNG phát token, không cookie, không session', async () => {
      const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send(body()).expect(201);

      expect(res.body).toEqual({ user: expect.objectContaining({ displayName: 'An', emailVerifiedAt: null }), requiresEmailVerification: true });
      expect(res.body.user).not.toHaveProperty('passwordHash');
      expect(res.body).not.toHaveProperty('accessToken');
      expect(([] as string[]).concat(res.headers['set-cookie'] ?? []).some((c) => c.startsWith('rt='))).toBe(false);
      expect(await prisma.session.count({ where: { userId: res.body.user.id } })).toBe(0);
    });

    it('DB + verify-email: mật khẩu argon2, mail chứa link; verify -> accessToken + cookie refresh httpOnly, session lưu sha256', async () => {
      const send = vi.spyOn(app.get(MailService), 'send');
      const email = newEmail();
      const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send(body(email)).expect(201);
      const userId = res.body.user.id as string;

      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);

      // Mail gửi qua event (async) nên có thể tới SAU response: chờ tới khi listener chạy xong
      const link = await vi.waitFor(() => send.mock.calls.find((c) => c[0] === email)![2]);
      const verifyToken = new URL(link).searchParams.get('token')!;
      const vt = await prisma.verificationToken.findFirstOrThrow({ where: { userId } });
      expect(vt).toMatchObject({ type: 'EMAIL_VERIFY', tokenHash: sha256(verifyToken), usedAt: null });

      const verified = await request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ token: verifyToken }).expect(200);
      expect(verified.body.user).toMatchObject({ id: userId, emailVerifiedAt: expect.any(String) });
      expect(await jwt.verifyAsync(verified.body.accessToken)).toMatchObject({ sub: userId });

      const cookie = ([] as string[]).concat(verified.headers['set-cookie'] ?? []).find((c) => c.startsWith('rt='))!;
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
      expect(cookie).toMatch(/SameSite=Lax/);
      const session = await prisma.session.findFirstOrThrow({ where: { userId } });
      expect(session.tokenHash).toBe(sha256(cookie.split(';')[0]!.slice(3)));
    });

    it('email trùng (kể cả khác hoa/thường, có khoảng trắng) -> 409 EMAIL_TAKEN gắn vào field email', async () => {
      const email = newEmail();
      await request(app.getHttpServer()).post('/api/v1/auth/register').send(body(email)).expect(201);
      const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send(body(` ${email.toUpperCase()} `)).expect(409);
      expect(res.body).toEqual({ errors: [{ code: 'EMAIL_TAKEN', message: 'Email đã được sử dụng', field: 'email' }] });
    });

    it('body sai -> 400 VALIDATION_ERROR, mỗi lỗi một field: email sai định dạng, mật khẩu ngắn, field lạ (chặn gửi kèm role)', async () => {
      const post = (b: object) => request(app.getHttpServer()).post('/api/v1/auth/register').send(b).expect(400);
      expect((await post({ ...body(), email: 'not-an-email' })).body.errors).toEqual([
        { code: 'VALIDATION_ERROR', field: 'email', message: expect.any(String) },
      ]);
      expect((await post({ ...body(), password: 'short' })).body.errors[0]).toMatchObject({ field: 'password' });
      expect((await post({ ...body(), role: 'admin' })).body.errors[0]).toMatchObject({ code: 'VALIDATION_ERROR', field: null });
    });

    it('JSON hỏng / route không có -> vẫn cùng dạng { errors }', async () => {
      const bad = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .set('Content-Type', 'application/json')
        .send('{"email":')
        .expect(400);
      expect(bad.body.errors[0]).toMatchObject({ code: 'VALIDATION_ERROR', field: null });
      const missing = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
      expect(missing.body.errors[0]).toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('POST /api/v1/auth/resend-verification', () => {
    const resend = (email: string) =>
      request(app.getHttpServer()).post('/api/v1/auth/resend-verification').send({ email }).expect(204);
    const verify = (token: string) => request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ token });
    const tokenFromMail = (send: { mock: { calls: unknown[][] } }, email: string, nth: number) =>
      vi.waitFor(() => {
        const link = send.mock.calls.filter((c) => c[0] === email)[nth]![2] as string;
        return new URL(link).searchParams.get('token')!;
      });

    it('link cũ hết hiệu lực, link mới dùng được; gọi lại ngay -> vẫn 204 nhưng không gửi thêm mail', async () => {
      const send = vi.spyOn(app.get(MailService), 'send');
      const email = `${randomUUID()}@e2e.test`;
      await request(app.getHttpServer()).post('/api/v1/auth/register').send({ email, password: 'correct-horse-1', displayName: 'An' }).expect(201);
      const oldToken = await tokenFromMail(send, email, 0);

      await resend(` ${email.toUpperCase()} `); // chuẩn hóa email giống register
      const newToken = await tokenFromMail(send, email, 1);
      await resend(email); // trong 60s chờ

      expect((await verify(oldToken)).body.errors[0].code).toBe('INVALID_VERIFY_TOKEN');
      expect((await verify(newToken)).status).toBe(200);
      expect(send.mock.calls.filter((c) => c[0] === email)).toHaveLength(2); // mail đăng ký + đúng 1 mail gửi lại
    });

    it('email không tồn tại / đã verify -> vẫn 204, không gửi mail', async () => {
      const send = vi.spyOn(app.get(MailService), 'send');
      const email = `${randomUUID()}@e2e.test`;
      await request(app.getHttpServer()).post('/api/v1/auth/register').send({ email, password: 'correct-horse-1', displayName: 'An' }).expect(201);
      await verify(await tokenFromMail(send, email, 0)).expect(200);
      send.mockClear();

      await resend(email);
      await resend(`${randomUUID()}@e2e.test`);
      await new Promise((r) => setTimeout(r, 50)); // listener chạy async: cho nó cơ hội chạy nếu lỡ có event
      expect(send).not.toHaveBeenCalled();
    });

    it('email sai định dạng -> 400 VALIDATION_ERROR field email', async () => {
      const res = await request(app.getHttpServer()).post('/api/v1/auth/resend-verification').send({ email: 'x' }).expect(400);
      expect(res.body.errors[0]).toMatchObject({ code: 'VALIDATION_ERROR', field: 'email' });
    });
  });

  describe('POST /api/v1/auth/refresh + /logout', () => {
    const rtOf = (res: request.Response) =>
      ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('rt='))?.split(';')[0]!.slice(3);
    const refresh = (rt?: string) => {
      const req = request(app.getHttpServer()).post('/api/v1/auth/refresh');
      return rt ? req.set('Cookie', `rt=${rt}`) : req;
    };
    // Đăng ký + verify (phương án B) -> có cookie refresh đầu tiên
    const signIn = async () => {
      const send = vi.spyOn(app.get(MailService), 'send');
      const email = `${randomUUID()}@e2e.test`;
      await request(app.getHttpServer()).post('/api/v1/auth/register').send({ email, password: 'correct-horse-1', displayName: 'An' }).expect(201);
      const link = await vi.waitFor(() => send.mock.calls.find((c) => c[0] === email)![2]);
      const res = await request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ token: new URL(link).searchParams.get('token') }).expect(200);
      return { userId: res.body.user.id as string, rt: rtOf(res)! };
    };

    it('refresh: access token mới + cookie MỚI; token cũ hết dùng được', async () => {
      const { userId, rt } = await signIn();
      const res = await refresh(rt).expect(200);
      expect(await jwt.verifyAsync(res.body.accessToken)).toMatchObject({ sub: userId });
      const next = rtOf(res)!;
      expect(next).not.toBe(rt);

      const old = await prisma.session.findUniqueOrThrow({ where: { tokenHash: sha256(rt) } });
      const fresh = await prisma.session.findUniqueOrThrow({ where: { tokenHash: sha256(next) } });
      expect(old).toMatchObject({ revokedAt: expect.any(Date), replacedById: fresh.id });
      expect(fresh.familyId).toBe(old.familyId);

      expect((await refresh(rt).expect(401)).body.errors[0].code).toBe('INVALID_REFRESH_TOKEN');
      await refresh(next).expect(200); // token mới vẫn dùng được (lần dùng lại trên nằm trong 10s ân hạn)
    });

    it('dùng lại token đã bị thay từ lâu (bị đánh cắp) -> 401 và thu hồi CẢ family, token mới cũng chết', async () => {
      const { userId, rt } = await signIn();
      const next = rtOf(await refresh(rt).expect(200))!;
      await prisma.session.updateMany({ where: { tokenHash: sha256(rt) }, data: { revokedAt: new Date(Date.now() - 60_000) } }); // giả lập "đã lâu"

      await refresh(rt).expect(401);
      expect(await prisma.session.count({ where: { userId, revokedAt: null } })).toBe(0);
      await refresh(next).expect(401);
    });

    it('2 request refresh cùng lúc, cùng cookie -> đúng 1 thành công, chỉ 1 session mới', async () => {
      const { userId, rt } = await signIn();
      const statuses = (await Promise.all([refresh(rt), refresh(rt)])).map((r) => r.status).sort((x, y) => x - y);
      expect(statuses).toEqual([200, 401]);
      expect(await prisma.session.count({ where: { userId } })).toBe(2); // session đầu + 1 session mới
    });

    it('logout: 204, xóa cookie đúng path, session bị thu hồi -> refresh bằng cookie đó 401', async () => {
      const { rt } = await signIn();
      const res = await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Cookie', `rt=${rt}`).expect(204);
      const cleared = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('rt='))!;
      expect(cleared).toMatch(/^rt=;/);
      expect(cleared).toMatch(/Path=\/api\/v1\/auth/);
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      await refresh(rt).expect(401);
    });

    it('không có cookie: refresh 401, logout vẫn 204', async () => {
      expect((await refresh().expect(401)).body.errors[0].code).toBe('INVALID_REFRESH_TOKEN');
      await request(app.getHttpServer()).post('/api/v1/auth/logout').expect(204);
      await refresh('token-bia').expect(401);
    });
  });

  describe('JWT guard (Passport strategy "jwt")', () => {
    it('không token -> 401', () => request(app.getHttpServer()).get('/api/v1/me').expect(401));

    it('token hợp lệ -> 200, req.user = { id }', async () => {
      const token = await jwt.signAsync({ sub: 'user-123' });
      await request(app.getHttpServer()).get('/api/v1/me').auth(token, { type: 'bearer' }).expect(200, { id: 'user-123' });
    });

    it('token sai chữ ký / hết hạn -> 401 chung, không lộ lý do', async () => {
      const forged = await new JwtService({ secret: 'x'.repeat(32) }).signAsync({ sub: 'admin' });
      const expired = await jwt.signAsync({ sub: 'user-123' }, { expiresIn: -10 });
      for (const token of [forged, expired]) {
        const res = await request(app.getHttpServer()).get('/api/v1/me').auth(token, { type: 'bearer' }).expect(401);
        expect(JSON.stringify(res.body)).not.toMatch(/expired|signature/i);
      }
    });
  });

  describe('Google OAuth (Passport strategy "google")', () => {
    it('GET /api/v1/auth/google -> 302 sang Google, có state + PKCE S256, state lưu trong Redis', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/auth/google').expect(302);
      const url = new URL(res.headers['location']!);
      expect(url.origin).toBe('https://accounts.google.com');
      expect(url.searchParams.get('client_id')).toBe('e2e-client.apps.googleusercontent.com');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      const state = url.searchParams.get('state')!;
      const redis = app.get<RedisClient>(REDIS);
      expect(await redis.get(`oauth:google:state:${state}`)).toBeTruthy(); // verifier chờ callback
    });

    it('callback với state giả -> bị từ chối, không đổi code với Google', async () => {
      await request(app.getHttpServer()).get('/api/v1/auth/google/callback?code=fake&state=forged').expect(401);
    });
  });
});
