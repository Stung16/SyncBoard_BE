import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from 'argon2';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { PrismaService } from '../src/infra/database/prisma.service.js';
import { REDIS, type RedisClient } from '../src/infra/redis/redis.module.js';
import { BoardService } from '../src/modules/board/services/board.service.js';
import { createUser } from './helpers.js';

describe('Audit log (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const api = (token: string) => {
    const http = request(app.getHttpServer());
    const auth = <T extends { set: (k: string, v: string) => T }>(r: T) => r.set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => auth(http.get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) => auth(http.post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) => auth(http.patch(`/api/v1${path}`)).send(body),
      delete: (path: string) => auth(http.delete(`/api/v1${path}`)),
    };
  };
  const logsOfBoard = (boardId: string) => prisma.auditLog.findMany({ where: { boardId }, orderBy: { id: 'asc' } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await setupApp(app);
    await app.listen(0);
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    const redis = app.get<RedisClient>(REDIS);
    const keys = await redis.keys('rl:*');
    if (keys.length) await redis.del(keys);
  });

  afterAll(async () => {
    await app.close();
  });

  it('đăng nhập đúng -> auth.login kèm IP; sai mật khẩu / email không có -> auth.login_failed (actorId null khi không có tài khoản)', async () => {
    const email = `${randomUUID()}@e2e.test`;
    const user = await prisma.user.create({ data: { email, displayName: 'E2E', emailVerifiedAt: new Date(), passwordHash: await hash('secret-pass-1') } });
    const login = (e: string, password: string) => request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: e, password });

    await login(email, 'wrong-pass-1').expect(401);
    const ghost = `${randomUUID()}@e2e.test`;
    await login(ghost, 'wrong-pass-1').expect(401);
    await login(email, 'secret-pass-1').expect(200);

    const mine = await prisma.auditLog.findMany({ where: { actorId: user.id }, orderBy: { id: 'asc' } });
    expect(mine.map((l) => l.action)).toEqual(['auth.login_failed', 'auth.login']);
    expect(mine.every((l) => typeof l.ip === 'string' && l.ip.length > 0)).toBe(true); // IP đi qua interceptor tới service
    const failedGhost = await prisma.auditLog.findFirstOrThrow({ where: { action: 'auth.login_failed', metadata: { equals: { email: ghost } } } });
    expect(failedGhost.actorId).toBeNull();
  });

  it('các thao tác quản trị bảng đều được ghi đúng thứ tự, đủ chi tiết; token link chia sẻ KHÔNG nằm trong log', async () => {
    const [owner, member] = [await createUser(app), await createUser(app)];
    const o = api(owner.token);
    const { body: board } = await o.post('/boards', { title: 'Kế hoạch' }).expect(201);
    await prisma.boardMember.create({ data: { boardId: board.id, userId: member.id, role: 'EDITOR' } });
    await o.patch(`/boards/${board.id}`, { title: 'Kế hoạch Q4' }).expect(200);
    const { body: link } = await o.post(`/boards/${board.id}/share-links`, { role: 'VIEWER' }).expect(201);
    await o.delete(`/boards/${board.id}/share-links/${link.id}`).expect(204);
    await o.patch(`/boards/${board.id}/members/${member.id}`, { role: 'VIEWER' }).expect(200);
    await o.delete(`/boards/${board.id}/members/${member.id}`).expect(204);
    await app.get(BoardService).submitOps(board.id, owner.id, [{ opId: randomUUID(), type: 'clear' }]); // qua socket: không có IP
    await o.delete(`/boards/${board.id}`).expect(204);

    const logs = await logsOfBoard(board.id);
    expect(logs.map((l) => [l.action, l.actorId, l.metadata])).toEqual([
      ['board.create', owner.id, { title: 'Kế hoạch' }],
      ['board.rename', owner.id, { title: 'Kế hoạch Q4' }],
      ['share_link.create', owner.id, { linkId: link.id, role: 'VIEWER', expiresAt: null }],
      ['share_link.revoke', owner.id, { linkId: link.id }],
      ['member.role_change', owner.id, { userId: member.id, from: 'EDITOR', to: 'VIEWER' }],
      ['member.remove', owner.id, { userId: member.id, role: 'VIEWER' }],
      ['board.clear', owner.id, { seq: 1, count: 0 }],
      ['board.delete', owner.id, {}],
    ]);
    expect(JSON.stringify(logs)).not.toContain(link.token);
    expect(logs.find((l) => l.action === 'board.clear')!.ip).toBeNull();
  });

  it('thao tác bị từ chối (không có quyền) KHÔNG sinh log', async () => {
    const [owner, editor] = [await createUser(app), await createUser(app)];
    const { body: board } = await api(owner.token).post('/boards', {}).expect(201);
    await prisma.boardMember.create({ data: { boardId: board.id, userId: editor.id, role: 'EDITOR' } });
    await api(editor.token).patch(`/boards/${board.id}`, { title: 'x' }).expect(403);
    await api(editor.token).delete(`/boards/${board.id}`).expect(403);
    expect((await logsOfBoard(board.id)).map((l) => l.action)).toEqual(['board.create']);
  });

  it('GET /boards/:id/audit-logs: chỉ OWNER (EDITOR -> 403); mới nhất trước; ?before= sang trang không sót không lặp', async () => {
    const [owner, editor] = [await createUser(app), await createUser(app)];
    const { body: board } = await api(owner.token).post('/boards', {}).expect(201);
    await prisma.boardMember.create({ data: { boardId: board.id, userId: editor.id, role: 'EDITOR' } });
    // 150 dòng giả, nhiều dòng cùng mili-giây (createdAt giống nhau) -> phân trang theo id vẫn đúng
    const at = new Date();
    await prisma.auditLog.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({ actorId: owner.id, boardId: board.id, action: 'board.rename', metadata: { i }, createdAt: at })),
    });

    await api(editor.token).get(`/boards/${board.id}/audit-logs`).expect(403);
    const page1 = (await api(owner.token).get(`/boards/${board.id}/audit-logs`).expect(200)).body as { id: string }[];
    expect(page1).toHaveLength(100);
    const page2 = (await api(owner.token).get(`/boards/${board.id}/audit-logs?before=${page1.at(-1)!.id}`).expect(200)).body as { id: string }[];
    expect(page2).toHaveLength(51); // 50 dòng giả còn lại + board.create
    const all = [...page1, ...page2].map((l) => l.id);
    expect(new Set(all).size).toBe(151);
    expect([...all].sort().reverse()).toEqual(all); // id giảm dần = mới nhất trước
    await api(owner.token).get(`/boards/${board.id}/audit-logs?before=nope`).expect(400);
  });
});
