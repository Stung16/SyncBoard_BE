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

  describe('POST /api/v1/auth/register', () => {
    const newEmail = () => `${randomUUID()}@e2e.test`;
    const body = (email = newEmail()) => ({ email, password: 'correct-horse-1', displayName: 'An' });

    it('201: trả accessToken + user (không có passwordHash), đặt cookie refresh httpOnly đúng path', async () => {
      const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send(body()).expect(201);

      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.user).toMatchObject({ displayName: 'An', emailVerifiedAt: null });
      expect(res.body.user).not.toHaveProperty('passwordHash');
      expect(await jwt.verifyAsync(res.body.accessToken)).toMatchObject({ sub: res.body.user.id });

      const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('rt='))!;
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
      expect(cookie).toMatch(/SameSite=Lax/);
    });

    it('DB: mật khẩu băm argon2, session lưu sha256 của cookie, có token xác minh email; mail chứa link', async () => {
      const send = vi.spyOn(app.get(MailService), 'send');
      const email = newEmail();
      const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send(body(email)).expect(201);
      const userId = res.body.user.id as string;
      const refresh = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('rt='))!.split(';')[0]!.slice(3);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);

      const session = await prisma.session.findFirstOrThrow({ where: { userId } });
      expect(session.tokenHash).toBe(sha256(refresh));

      const link = send.mock.calls.find((c) => c[0] === email)![2];
      const verifyToken = new URL(link).searchParams.get('token')!;
      const vt = await prisma.verificationToken.findFirstOrThrow({ where: { userId } });
      expect(vt).toMatchObject({ type: 'EMAIL_VERIFY', tokenHash: sha256(verifyToken), usedAt: null });
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
