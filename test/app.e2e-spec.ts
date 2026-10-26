import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';

describe('REST (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health -> ok (app + DB sống), không bị prefix /api', () => {
    return request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
  });

  it('helmet gắn header bảo mật', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined(); // không lộ "Express"
  });

  it('CORS: origin hợp lệ được phép kèm credentials, origin lạ thì không', async () => {
    const ok = await request(app.getHttpServer()).get('/health').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await request(app.getHttpServer()).get('/health').set('Origin', 'http://evil.test');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('route nghiệp vụ nằm dưới /api', async () => {
    await request(app.getHttpServer()).get('/boards').expect(404);
    await request(app.getHttpServer()).get('/api/docs-json').expect(200); // Swagger (không bật khi production)
  });
});
