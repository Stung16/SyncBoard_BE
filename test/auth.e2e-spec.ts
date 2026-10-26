import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { REDIS, type RedisClient } from '../src/infra/redis/redis.module.js';

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await setupApp(app);
    await app.init();
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('JWT guard (Passport strategy "jwt")', () => {
    it('không token -> 401', () => request(app.getHttpServer()).get('/api/me').expect(401));

    it('token hợp lệ -> 200, req.user = { id }', async () => {
      const token = await jwt.signAsync({ sub: 'user-123' });
      await request(app.getHttpServer()).get('/api/me').auth(token, { type: 'bearer' }).expect(200, { id: 'user-123' });
    });

    it('token sai chữ ký / hết hạn -> 401 chung, không lộ lý do', async () => {
      const forged = await new JwtService({ secret: 'x'.repeat(32) }).signAsync({ sub: 'admin' });
      const expired = await jwt.signAsync({ sub: 'user-123' }, { expiresIn: -10 });
      for (const token of [forged, expired]) {
        const res = await request(app.getHttpServer()).get('/api/me').auth(token, { type: 'bearer' }).expect(401);
        expect(JSON.stringify(res.body)).not.toMatch(/expired|signature/i);
      }
    });
  });

  describe('Google OAuth (Passport strategy "google")', () => {
    it('GET /api/auth/google -> 302 sang Google, có state + PKCE S256, state lưu trong Redis', async () => {
      const res = await request(app.getHttpServer()).get('/api/auth/google').expect(302);
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
      await request(app.getHttpServer()).get('/api/auth/google/callback?code=fake&state=forged').expect(401);
    });
  });
});
